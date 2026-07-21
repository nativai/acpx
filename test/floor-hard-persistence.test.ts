import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileSessionStore } from "../src/runtime.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// REGRESSION (TE-found, brick://07dd62c9): serializeSessionRecordForDisk writes the
// whole acpx object, but parseSessionRecord reconstructs acpx field-by-field from a
// WHITELIST — so any field parse.ts does not know is STRIPPED on every disk load
// (every queue-owner delivery + owner respawn). The InMemorySessionStore durability
// test (structuredClone) never exercises parse, so it missed this. This test round-
// trips through the REAL FileSessionStore (write → parse-on-load) and asserts the
// four new floor fields survive — the fidelity gate against the stripping asymmetry.

test("FileSessionStore round-trip preserves floor_hard + served + served_below_floor + floor_parked", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-floor-store-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const store = createFileSessionStore({ stateDir });
  const record = makeSessionRecord({
    acpxRecordId: "floor-persist-rec",
    acpSessionId: "floor-persist-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {
      current_model_id: "fable",
      session_options: {
        model: "fable",
        effort: "max",
        auto_failover: false,
        floor_hard: true,
      },
      desired_config_options: { effort: "max" },
      served: {
        model: "claude-sonnet-4-6",
        effort: "high",
        at: "2026-07-20T12:00:00.000Z",
        source: "claude-transcript",
      },
      served_below_floor: {
        served_model: "claude-sonnet-4-6",
        served_effort: "high",
        pinned_model: "fable",
        pinned_effort: "max",
        at: "2026-07-20T12:00:00.000Z",
      },
      floor_parked: {
        at: "2026-07-20T12:00:00.000Z",
        reason: "model-floor-unmet",
        observed_model: "claude-sonnet-4-6",
      },
    },
  });

  await store.save(record);
  const loaded = await store.load("floor-persist-rec");
  assert.ok(loaded, "record must load");

  // The durable POLICY flag survives — this is the airtight-quarantine gate.
  assert.equal(loaded.acpx?.session_options?.floor_hard, true);
  // Sanity: the analogue field that already round-tripped still does.
  assert.equal(loaded.acpx?.session_options?.auto_failover, false);

  // The live served block survives (whoami / cross-session floor reads depend on it).
  assert.equal(loaded.acpx?.served?.model, "claude-sonnet-4-6");
  assert.equal(loaded.acpx?.served?.effort, "high");
  assert.equal(loaded.acpx?.served?.at, "2026-07-20T12:00:00.000Z");
  assert.equal(loaded.acpx?.served?.source, "claude-transcript");

  // The audit breadcrumb survives.
  assert.equal(loaded.acpx?.served_below_floor?.served_model, "claude-sonnet-4-6");
  assert.equal(loaded.acpx?.served_below_floor?.pinned_model, "fable");
  assert.equal(loaded.acpx?.served_below_floor?.at, "2026-07-20T12:00:00.000Z");

  // The durable PARK survives — the ⭐ retry-across-time/park-survives-respawn proof.
  assert.equal(loaded.acpx?.floor_parked?.reason, "model-floor-unmet");
  assert.equal(loaded.acpx?.floor_parked?.observed_model, "claude-sonnet-4-6");
  assert.equal(loaded.acpx?.floor_parked?.at, "2026-07-20T12:00:00.000Z");
});

test("FileSessionStore round-trip: floor_hard absent stays absent (default mode not fabricated)", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-floor-store-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const store = createFileSessionStore({ stateDir });
  const record = makeSessionRecord({
    acpxRecordId: "floor-default-rec",
    acpSessionId: "floor-default-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: { session_options: { model: "fable", effort: "max" } },
  });
  await store.save(record);
  const loaded = await store.load("floor-default-rec");
  assert.equal(loaded?.acpx?.session_options?.floor_hard, undefined);
  assert.equal(loaded?.acpx?.served, undefined);
});
