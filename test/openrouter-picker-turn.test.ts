import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OPENROUTER_DISABLED_CLAUDE_CAPABILITIES,
  OPENROUTER_SHIM_AUTH_PLACEHOLDER,
  pointAdapterAtShim,
} from "../src/acp/auth-env.js";
import { shimConfigDirSessionId, type AcpClient } from "../src/acp/client.js";
import { applyPromptModelIfAdvertised } from "../src/cli/session/runtime.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SESSION_RECORD_SCHEMA, type SessionRecord } from "../src/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Brick 007eaac8 — THE TURN PATH.
//
// 🛑 WHY THIS FILE EXISTS, IN ONE SENTENCE: a picker-route session CREATED
// cleanly, took the user's first prompt, and then FAILED the turn with "the ACP
// agent did not advertise that model", while the picker advertised claude's
// OpenRouter rows as selectable — an honest refusal at create had been converted
// into an invitation that broke on use.
//
// ⚠️ AND WHY THE EXISTING TESTS DID NOT CATCH IT. The create path goes through
// `applyRequestedModelIfAdvertised`, where the out-of-band suppression lived; the
// PROMPT path does not go through that dispatcher — it calls
// `assertRequestedModelSupported` itself. So a four-route accept/refuse table was
// 4/4 correct and a create-time suite was green while the first turn was broken.
// A decision test is not an engagement test, and neither is a turn test.
// Measured on session cd93c99f (2026-09-07): the shim WAS engaged — its isolated
// `or-<id>` config dir existed and `current_model_id` carried the slug — and the
// turn threw anyway.
//
// ⚠️ THIS FILE IS DELIBERATELY SEPARATE from `openrouter-picker-route.test.ts`
// (the decision/unit half) so the two cannot be confused for each other, and it
// is named so it cannot collide with another lane's `pi-models-store.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const SLUG = "moonshotai/kimi-k3";

/** The adapter's REAL advertisement — deliberately WITHOUT the slug. That is the
 *  whole point: claude-agent-acp advertises only its own aliases, so an
 *  unsuppressed apply throws exactly here. */
const CLAUDE_ADVERTISED = ["default", "opus[1m]", "sonnet", "haiku", "opus", "fable"];

function recordFor(model: string, currentModelId: string = model): SessionRecord {
  const now = "2026-09-07T00:00:00.000Z";
  return {
    schema: SESSION_RECORD_SCHEMA,
    acpxRecordId: "turn-record-007eaac8",
    acpSessionId: "acp-session-007eaac8",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/tmp/workspace",
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog("turn-record-007eaac8"),
    closed: false,
    closedAt: undefined,
    pid: undefined,
    agentStartedAt: undefined,
    protocolVersion: undefined,
    agentCapabilities: undefined,
    ...createSessionConversation(now),
    acpx: {
      available_models: CLAUDE_ADVERTISED,
      current_model_id: currentModelId,
      session_options: { model, model_source: "explicit" },
    },
  };
}

/** A stub standing in for `AcpClient`, recording every ACP model call it is asked
 *  to make. `outOfBandModelId` is the ONE field the suppression turns on. */
function clientStub(outOfBandModelId: string | undefined) {
  const wireCalls: string[] = [];
  const client = {
    outOfBandModelId,
    setSessionModel: async (_sessionId: string, modelId: string) => {
      wireCalls.push(modelId);
    },
    setSessionConfigOption: async () => ({}),
    modelSetMethodIsUnsupported: false,
  } as unknown as AcpClient;
  return { client, wireCalls };
}

/**
 * ⚠️ ISOLATE THE STORE BEFORE THE PIN IS PERSISTED. `persistChangedModelPin`
 * writes a real session record, and `ACPX_STATE_HOME` is the seam that decides
 * where (`repository.ts:94`). Without this the test would write into devbox's
 * PRODUCTION session store — creating a record is a write even when nothing is
 * ever prompted.
 */
function isolatedStore(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-l7-turn-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("THE REGRESSION — a turn on a picker-route session does not throw and sends nothing on the wire", async (t) => {
  const home = isolatedStore(t);
  const { client, wireCalls } = clientStub(SLUG);
  // `current_model_id` deliberately starts on something ELSE, so the pin actually
  // CHANGES and `persistChangedModelPin` really writes. Starting it already on the
  // slug makes that helper return early, and the store assertion below would then
  // be asserting a write that never had to happen.
  const record = recordFor(SLUG, "sonnet");

  // Before the fix this call threw:
  //   Cannot apply --model "moonshotai/kimi-k3": the ACP agent did not advertise
  //   that model. Available models: default, opus[1m], sonnet, …
  await applyPromptModelIfAdvertised({
    client,
    sessionId: record.acpSessionId,
    requestedModel: SLUG,
    requestedModelSource: "explicit",
    record,
    verbose: false,
  });

  assert.deepEqual(wireCalls, [], "the slug must never reach session/set_model");
  assert.equal(record.acpx?.current_model_id, SLUG);
  // `setDesiredModelId` writes `session_options.model` (mode-preference.ts:247-256),
  // not a `desired_model_id` key — the first draft asserted the latter and the
  // typechecker refused it.
  assert.equal(record.acpx?.session_options?.model, SLUG, "the pin is persisted, not skipped");
  // The store this wrote to is the temp one, which is also the proof the
  // production store was never touched.
  assert.ok(fs.existsSync(path.join(home, ".acpx", "sessions")), "the isolated store was used");
});

test("THE NEGATIVE CONTROL — with nothing served out of band the SAME call still throws", async (t) => {
  // ⚠️ WITHOUT THIS ROW THE TEST ABOVE PROVES NOTHING. "Did not throw" is equally
  // consistent with "the suppression fired" and with "this path never checks the
  // advertisement at all" — and the second reading would mean the guard that
  // catches a genuinely bogus model on claude had been deleted. This row is what
  // separates them: identical inputs, `outOfBandModelId` undefined, must throw.
  isolatedStore(t);
  const { client, wireCalls } = clientStub(undefined);
  await assert.rejects(
    applyPromptModelIfAdvertised({
      client,
      sessionId: "acp-session-007eaac8",
      requestedModel: SLUG,
      requestedModelSource: "explicit",
      record: recordFor(SLUG),
      verbose: false,
    }),
    /did not advertise that model/,
  );
  assert.deepEqual(wireCalls, []);
});

test("THE SUPPRESSION IS EXACT — a claude alias on the same session still goes on the wire", async (t) => {
  // The other way the fix could be wrong: a client that is serving ONE model out
  // of band must not become a blanket no-op for every other model on that
  // session, or the suppression would hide real failures instead of one
  // known-good case.
  isolatedStore(t);
  const { client, wireCalls } = clientStub(SLUG);
  const record = recordFor(SLUG);
  record.acpx = { ...record.acpx, current_model_id: "sonnet" };

  await applyPromptModelIfAdvertised({
    client,
    sessionId: record.acpSessionId,
    requestedModel: "haiku",
    requestedModelSource: "explicit",
    record,
    verbose: false,
  });

  assert.deepEqual(wireCalls, ["haiku"], "an ordinary claude alias must still be applied");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND DEFECT ON THIS ROUTE — the adapter could not make a request at all.
// ─────────────────────────────────────────────────────────────────────────────

test("the adapter's shim auth token is NON-BLANK — a blank one refuses locally and sends nothing", () => {
  // 🛑 THIS WAS `" "` — A SINGLE SPACE — with a comment that had become false.
  // `claude-agent-acp 0d5ab3ab` (2026-09-01) bumped the SDK to Claude Code
  // 2.1.257, after which a blank token makes Claude Code answer
  // `Not logged in · Please run /login` LOCALLY: measured over five sessions on
  // disk (authentication_failed, input_tokens: 0, model <synthetic>) and by a
  // two-arm probe in which arm A produced ZERO POST /v1/messages.
  //
  // The assertion is on BLANKNESS, not on the literal, because blankness is the
  // property that was measured. Pinning the exact string would go red on a
  // harmless rename and still pass on `"\t"`.
  const env: NodeJS.ProcessEnv = {};
  pointAdapterAtShim(env, 41234);

  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:41234");
  assert.ok(
    (env.ANTHROPIC_AUTH_TOKEN ?? "").trim().length > 0,
    "a blank ANTHROPIC_AUTH_TOKEN makes Claude Code refuse before any HTTP call",
  );
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, OPENROUTER_SHIM_AUTH_PLACEHOLDER);
  // ⚠️ It must stay an OBVIOUS placeholder. The shim overwrites the header
  // downstream, so this value never leaves the box — and the way it stays that
  // way is that nobody can mistake it for a credential.
  assert.doesNotMatch(env.ANTHROPIC_AUTH_TOKEN ?? "", /^sk-/, "never credential-shaped");
});

test("the subscription path's custom headers are cleared, so the shim's own Authorization stands", () => {
  // The negative control for the row above: pointAdapterAtShim must do all three
  // things, not just the one that was broken. A leftover ANTHROPIC_CUSTOM_HEADERS
  // from the subscription path would ride alongside the shim's injected header.
  const env: NodeJS.ProcessEnv = { ANTHROPIC_CUSTOM_HEADERS: "X-Leftover: 1" };
  pointAdapterAtShim(env, 41234);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("a blank record id never yields the SHARED /tmp/or- config dir — on either route", () => {
  // ⚠️ `??` DOES NOT CATCH `""`, AND `""` IS THE NORMAL CASE AT CREATE.
  // `creationSessionContext` sets `acpxRecordId: ""` on the real `sessions new`
  // path, so the legacy route's `ctx?.acpxRecordId ?? profileId` produced
  // `join(tmpdir(), "or-" + "")` = `/tmp/or-`: one CLAUDE_CONFIG_DIR shared by
  // every blank-id session, defeating the per-session isolation that directory
  // exists for. The picker route already guarded it; the legacy route did not.
  //
  // ⚠️ ASSERTED ON `shimConfigDirSessionId` — THE FUNCTION BOTH CALL SITES USE —
  // NOT ON THE GENERIC TRIM HELPER. The first version of this test asserted the
  // helper, and a mutation probe proved it VACUOUS: reverting the legacy call
  // site to `?? profileId`, i.e. reinstating the exact defect, left this whole
  // file GREEN, because the helper was still correct and nothing here touched the
  // rule under repair. True and unattached is the pair that survives review.
  for (const blank of ["", " ", "\t", "\n", "   "]) {
    assert.equal(
      shimConfigDirSessionId({ acpxRecordId: blank }, "fallback-id"),
      "fallback-id",
      `${JSON.stringify(blank)} must fall back, not become part of the path`,
    );
  }
  // The positive control: a real id must survive untouched, or the rule would
  // "pass" by rejecting everything and every session would share the fallback.
  assert.equal(shimConfigDirSessionId({ acpxRecordId: "real-id" }, "fallback-id"), "real-id");
  assert.equal(shimConfigDirSessionId({ acpxRecordId: "  padded  " }, "fallback-id"), "padded");
  assert.equal(shimConfigDirSessionId(undefined, "fallback-id"), "fallback-id");
});

// ─────────────────────────────────────────────────────────────────────────────
// brick 92121ff9 — Anthropic-only wire constructs OFF for shim-served adapters.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How Claude Code 2.1.287 resolves `CLAUDE_CODE_MODEL_CAPABILITIES` for one
 * model — transcribed from the bundled binary's parser: `;`-separated clauses,
 * optional `<pattern>=` prefix (trailing `*` = prefix match, `[1m]` stripped
 * from the model), `-cap` disables, clauses applied IN ORDER so the last setting
 * of a capability wins. Used to assert what the CLI will EFFECTIVELY do with the
 * merged value, not merely what string acpx wrote.
 */
function effectiveCapabilityOverrides(value: string, model: string): Map<string, boolean> {
  const overrides = new Map<string, boolean>();
  const bare = model.replace(/\[1m\]/gi, "");
  for (const clause of value.split(";")) {
    const eq = clause.indexOf("=");
    if (eq !== -1) {
      const pattern = clause.slice(0, eq).trim();
      const matches =
        pattern !== "" &&
        (pattern.endsWith("*") ? bare.startsWith(pattern.slice(0, -1)) : bare === pattern);
      if (!matches) {
        continue;
      }
    }
    for (const raw of (eq === -1 ? clause : clause.slice(eq + 1)).split(",")) {
      const cap = raw.trim();
      const enabled = !cap.startsWith("-");
      overrides.set(enabled ? cap : cap.slice(1), enabled);
    }
  }
  return overrides;
}

function assertAllFiveOff(value: string | undefined, model: string): void {
  assert.ok(value, "CLAUDE_CODE_MODEL_CAPABILITIES must be set on a shim-served adapter");
  const overrides = effectiveCapabilityOverrides(value, model);
  for (const capability of OPENROUTER_DISABLED_CLAUDE_CAPABILITIES) {
    assert.equal(overrides.get(capability), false, `${capability} must resolve OFF for ${model}`);
  }
}

test("92121ff9 · the shim path disables all five capabilities, for any alias the CLI resolves", () => {
  const env: NodeJS.ProcessEnv = {};
  pointAdapterAtShim(env, 41234);
  assert.deepEqual(
    [...OPENROUTER_DISABLED_CLAUDE_CAPABILITIES],
    [
      "per_turn_effort",
      "per_turn_timing",
      "mid_conv_system",
      "mid_conv_tool_change",
      "context_management",
    ],
  );
  // Model-less clause: the CLI's alias resolution moves with every bump
  // (Opus 4.8 on 2.1.257, Opus 5.5 on 2.1.287), so the clause must not name one.
  for (const model of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "x"]) {
    assertAllFiveOff(env.CLAUDE_CODE_MODEL_CAPABILITIES, model);
  }
});

test("92121ff9 · a pre-existing operator value SURVIVES; ours is appended and wins for the five", () => {
  const operator = "claude-opus-5-5=fast_mode,per_turn_effort;claude-sonnet*=-lean_prompt";
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_MODEL_CAPABILITIES: operator };
  pointAdapterAtShim(env, 41234);
  const value = env.CLAUDE_CODE_MODEL_CAPABILITIES ?? "";
  assert.ok(value.startsWith(`${operator};`), "the operator's clauses are kept verbatim, first");
  // The operator ENABLED per_turn_effort for Opus 5.5 — behind the shim that is
  // the dead turn, so the appended clause must override it…
  assertAllFiveOff(value, "claude-opus-5-5");
  // …while everything else the operator set still holds.
  assert.equal(effectiveCapabilityOverrides(value, "claude-opus-5-5").get("fast_mode"), true);
  assert.equal(effectiveCapabilityOverrides(value, "claude-sonnet-5-5").get("lean_prompt"), false);
});

test("92121ff9 · spawn then reconnect (pointAdapterAtShim twice) does not duplicate the clause", () => {
  for (const initial of [undefined, "claude-opus-5-5=-fast_mode"]) {
    const env: NodeJS.ProcessEnv =
      initial === undefined ? {} : { CLAUDE_CODE_MODEL_CAPABILITIES: initial };
    pointAdapterAtShim(env, 41234);
    const once = env.CLAUDE_CODE_MODEL_CAPABILITIES;
    pointAdapterAtShim(env, 41235);
    assert.equal(env.CLAUDE_CODE_MODEL_CAPABILITIES, once);
    assert.equal((once ?? "").split(";").filter((c) => c.includes("-per_turn_effort")).length, 1);
  }
});
