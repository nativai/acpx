import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSessionOptions,
  persistSessionOptions,
  sessionOptionsFromRecord,
} from "../src/runtime/engine/session-options.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { mergeLatestDurableAcpxPreferences } from "../src/session/mode-preference.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// brick://5bac5564 Layer C — model_source (flat string) + model_guard (breadcrumb)
// must survive EVERY session_options transform leg or they silently drop
// (brick://07dd62c9). This is the CHEAP unit gate; R5 proves the same through REAL
// transforms on a non-default profile (an InMemory test false-passes the profile
// leg, hence R5 is still required).

function recordWithProvenance(acpx: SessionAcpxState): SessionRecord {
  return makeSessionRecord(
    {
      acpxRecordId: "prov",
      acpSessionId: "prov-acp",
      agentCommand: "claude",
      cwd: "/workspace/prov",
      acpx,
    },
    { resolveCwd: false },
  );
}

test("model_source survives parse → clone → sessionOptionsFromRecord", () => {
  const parsed = parseSessionRecord(
    serializeSessionRecordForDisk(
      recordWithProvenance({ session_options: { model: "opus", model_source: "guard-forced" } }),
    ),
  );
  assert.ok(parsed);
  assert.equal(parsed.acpx?.session_options?.model_source, "guard-forced");

  const cloned = cloneSessionAcpxState(parsed.acpx);
  assert.equal(cloned?.session_options?.model_source, "guard-forced");

  const options = sessionOptionsFromRecord(parsed);
  assert.deepEqual(options, { model: "opus", modelSource: "guard-forced" });
});

test("model_source rides the owner-respawn carry-forward paired with the pin", () => {
  // An owner respawn rebuilds session_options from the spawn flags. A flagless
  // rebuild (no model in the incoming options) must carry BOTH the stored pin and
  // its provenance forward — else the reuse-branch clobber-guard loses the signal.
  const record = recordWithProvenance({
    session_options: { model: "opus", model_source: "explicit" },
  });
  persistSessionOptions(record, { profile: "sub6", reasoningEffort: "high" });
  assert.equal(record.acpx?.session_options?.model, "opus");
  assert.equal(record.acpx?.session_options?.model_source, "explicit");
});

test("an explicit incoming model_source overrides the carried one", () => {
  const record = recordWithProvenance({
    session_options: { model: "fable", model_source: "guard-forced" },
  });
  persistSessionOptions(record, { model: "fable", modelSource: "explicit" });
  assert.equal(record.acpx?.session_options?.model, "fable");
  assert.equal(record.acpx?.session_options?.model_source, "explicit");
});

test("mergeSessionOptions threads modelSource (preferred wins)", () => {
  const merged = mergeSessionOptions(
    { model: "opus", modelSource: "guard-forced" },
    { model: "fable", modelSource: "inherited" },
  );
  assert.deepEqual(merged, { model: "opus", modelSource: "guard-forced" });
});

test("durable-overlay merge carries model_source over a stale turn snapshot", () => {
  // A disk-side `set model` changed the pin + provenance while a turn snapshot was
  // in flight — the latest disk state must win (mirror the `model` overlay).
  const pending: SessionAcpxState = {
    session_options: { model: "fable", model_source: "inherited" },
  };
  const latest: SessionAcpxState = {
    session_options: { model: "opus", model_source: "explicit" },
  };
  const merged = mergeLatestDurableAcpxPreferences(pending, latest);
  assert.equal(merged?.session_options?.model, "opus");
  assert.equal(merged?.session_options?.model_source, "explicit");
});

test("the model_guard breadcrumb survives parse → clone and rides carry-forward", () => {
  const guardState: SessionAcpxState = {
    session_options: {
      model: "opus",
      model_source: "guard-forced",
      model_guard: {
        blocked: "fable",
        forced_to: "opus",
        source: "inherited",
        at: "2026-07-21T00:00:00Z",
      },
    },
  };
  const parsed = parseSessionRecord(
    serializeSessionRecordForDisk(recordWithProvenance(guardState)),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.acpx?.session_options?.model_guard, {
    blocked: "fable",
    forced_to: "opus",
    source: "inherited",
    at: "2026-07-21T00:00:00Z",
  });

  const cloned = cloneSessionAcpxState(parsed.acpx);
  assert.deepEqual(cloned?.session_options?.model_guard, guardState.session_options?.model_guard);

  // Owner-respawn rebuild (no incoming model) keeps the breadcrumb visible.
  persistSessionOptions(parsed, { profile: "sub6" });
  assert.equal(parsed.acpx?.session_options?.model_guard?.blocked, "fable");
});

test("an invalid model_guard (missing fields) is dropped on parse, not fatal", () => {
  const parsed = parseSessionRecord(
    serializeSessionRecordForDisk(
      recordWithProvenance({
        session_options: {
          model: "opus",
          // @ts-expect-error deliberately malformed breadcrumb
          model_guard: { blocked: "fable" },
        },
      }),
    ),
  );
  assert.ok(parsed); // whole record still loads
  assert.equal(parsed.acpx?.session_options?.model_guard, undefined);
  assert.equal(parsed.acpx?.session_options?.model, "opus");
});
