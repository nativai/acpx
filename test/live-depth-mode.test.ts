import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { applyDepthOutcomeToRecord } from "../src/session/depth-application.js";
import { applyDepthAsMode } from "../src/session/depth-application.js";
import { getDesiredConfigOptions, getDesiredModeId } from "../src/session/mode-preference.js";
import { advertisedDepthLadderFromConfigOptions } from "../src/session/model-application.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// brick a3c65f0f — the LIVE depth arm for `mode`-mechanism harnesses (pi).
//
// THE DEFECT UNDER TEST: acpx-ui's live depth change spawned `pi set effort <rung>`
// (the config-option path); pi advertises no `effort` option and answers `-32602
// "Unknown config option: effort"` on EVERY rung. pi's real live path is
// `session/set_mode`, and an OpenRouter catalogue rung like `max` is not even a
// valid pi ThinkingLevel — so the rung must be PROJECTED onto the harness's
// advertised ladder, with the clamp recorded, never silent.
//
// The ladder facts below are MEASURED against the deployed pi-acp fork 0.0.33 +
// pi 0.84.4 on 2026-09-13 (probe scripts: brick a3c65f0f workspace): for
// `openrouter/z-ai/glm-5.3-flash` the post-model `config_option_update` advertises
// a `thought_level` select with values `["low","high"]` and a
// `thinkingLevelMap = {off:null, minimal:null, low:"low", medium:null, high:"high",
// xhigh:null, max:"max"}`. `max` is NOT an ACP mode id (the fork's
// ACP_THINKING_LEVELS is off|minimal|low|medium|high|xhigh).

/** The measured glm-5.3-flash `thought_level` select option (fixture, verbatim shape). */
function measuredThoughtLevelOption(currentValue = "high"): SessionConfigOption {
  const map = {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  };
  return {
    type: "select",
    id: "thought_level",
    category: "thought_level",
    name: "Thinking",
    description: "Set the reasoning effort for this session",
    currentValue,
    options: [
      {
        value: "low",
        name: "Thinking: low",
        description: "also selected by off, minimal (clamped)",
        _meta: { piAcp: { clampedFrom: ["off", "minimal"], thinkingLevelMap: map } },
      },
      {
        value: "high",
        name: "Thinking: high",
        description: "also selected by medium, xhigh (clamped)",
        _meta: { piAcp: { clampedFrom: ["medium", "xhigh"], thinkingLevelMap: map } },
      },
    ],
  } as unknown as SessionConfigOption;
}

function recordFor(agentCommand: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "rec-live-depth",
    acpSessionId: "rec-live-depth-acp",
    agentCommand,
    cwd: "/workspace/projects/temp",
  });
}

function modeClient(modeCalls: string[], rejectIds: ReadonlySet<string> = new Set()) {
  return {
    setSessionMode(sessionId: string, modeId: string): Promise<void> {
      if (rejectIds.has(modeId)) {
        return Promise.reject(new Error(`-32602 Unknown modeId: ${modeId}`));
      }
      modeCalls.push(`${sessionId}:${modeId}`);
      return Promise.resolve();
    },
  };
}

// ── The live ladder source ──────────────────────────────────────────────────────

test("the live depth ladder is read off the CURRENT advertisement's thought_level select", () => {
  // Measured: a session re-pinned to glm-5.3-flash advertises values [low, high].
  // The creation snapshot instead described the DEFAULT model (off…high) — reading
  // the ladder from there would project onto a ladder the session no longer sits on.
  const ladder = advertisedDepthLadderFromConfigOptions([measuredThoughtLevelOption("high")]);
  assert.ok(ladder, "no ladder derived from the measured advertisement");
  assert.deepEqual(
    ladder.availableModes.map((mode) => mode.id),
    ["low", "high"],
  );
  assert.equal(ladder.currentModeId, "high");
  // _meta is carried through: advertisedServedEffort reads _meta.piAcp.servedEffort.
  assert.ok(ladder.availableModes[1]._meta);
});

test("no thought_level select ⇒ no ladder (unavailable, never a guessed ladder)", () => {
  assert.equal(advertisedDepthLadderFromConfigOptions(undefined), undefined);
  assert.equal(advertisedDepthLadderFromConfigOptions([]), undefined);
  // An option with no values is a malformed advertisement, not an empty ladder.
  assert.equal(
    advertisedDepthLadderFromConfigOptions([
      {
        type: "select",
        id: "thought_level",
        category: "thought_level",
        currentValue: "low",
        options: [],
      } as unknown as SessionConfigOption,
    ]),
    undefined,
  );
  // Matched on CATEGORY, never on the option id (pi: thought_level, claude: effort)
  // — so re-labelling the option's id changes nothing, while a different category
  // is correctly not a depth ladder.
  assert.ok(
    advertisedDepthLadderFromConfigOptions([
      { ...measuredThoughtLevelOption(), id: "effort" } as unknown as SessionConfigOption,
    ]),
    "the option id must not gate the match",
  );
  assert.equal(
    advertisedDepthLadderFromConfigOptions([
      { ...measuredThoughtLevelOption(), category: "model" } as unknown as SessionConfigOption,
    ]),
    undefined,
  );
});

// ── The live apply: rung → projected mode → recorded outcome ───────────────────

test("live apply: offered rungs land exactly; max projects UP to high — recorded, not silent", async () => {
  // The measured advertisement's currentValue ("high") would make applyDepthAsMode
  // SKIP the wire send for anything landing on `high` (already there — its own
  // honest no-op). Pin the current mode OFF the ladder so every apply below must
  // actually reach the wire.
  const modes = advertisedDepthLadderFromConfigOptions([measuredThoughtLevelOption("high")]);
  assert.ok(modes);
  modes.currentModeId = "minimal";
  const modeCalls: string[] = [];
  const client = modeClient(modeCalls);

  const low = await applyDepthAsMode({
    client,
    sessionId: "acp-1",
    requested: "low",
    modes,
    harness: "pi",
  });
  assert.equal(low.kind, "exact");
  assert.equal(low.value, "low");

  const high = await applyDepthAsMode({
    client,
    sessionId: "acp-1",
    requested: "high",
    modes,
    harness: "pi",
  });
  assert.equal(high.kind, "exact");
  assert.equal(high.value, "high");

  // THE RUNG THAT CANNOT BE SERVED: catalogue `max` on a ladder topping out at
  // `high`. projectDepthOntoLadder's up-first-then-down rule lands on `high` —
  // pi's own clamp direction — and the outcome is `projected` with a reason, so
  // the record never claims max was served.
  const max = await applyDepthAsMode({
    client,
    sessionId: "acp-1",
    requested: "max",
    modes,
    harness: "pi",
  });
  assert.equal(max.kind, "projected");
  assert.equal(max.value, "high");
  assert.ok(max.reason, "a projected rung must carry its reason");
  assert.deepEqual(modeCalls, ["acp-1:low", "acp-1:high", "acp-1:high"]);
});

test("live apply with no advertisement at all: recorded unavailable, nothing sent", async () => {
  const modeCalls: string[] = [];
  const projection = await applyDepthAsMode({
    client: modeClient(modeCalls),
    sessionId: "acp-1",
    requested: "high",
    modes: undefined,
    harness: "pi",
  });
  assert.equal(projection.kind, "unavailable");
  assert.equal(projection.value, undefined);
  assert.ok(projection.reason, "the nothing must say why it is nothing");
  assert.deepEqual(modeCalls, []);
});

test("a mode the agent advertised and then rejected is a PROJECTION FAILURE, not a retry", async () => {
  // currentModeId is NOT high, so `high` is genuinely sent — and the stub rejects it
  // the way pi rejected `max` (measured: -32602 Unknown modeId).
  const modes = advertisedDepthLadderFromConfigOptions([measuredThoughtLevelOption("high")]);
  assert.ok(modes);
  modes.currentModeId = "minimal";
  const projection = await applyDepthAsMode({
    client: modeClient([], new Set(["high"])),
    sessionId: "acp-1",
    requested: "high",
    modes,
    harness: "pi",
  });
  assert.equal(projection.kind, "unavailable");
  assert.match(projection.reason ?? "", /ADVERTISED "high" and then rejected/);
});

// ── Record persistence: both live arms leave identical state ───────────────────

test("applyDepthOutcomeToRecord writes the request, the replayed mode, and the outcome", () => {
  const record = recordFor("node /opt/pi-acp/dist/index.js");
  applyDepthOutcomeToRecord(record, {
    kind: "projected",
    value: "high",
    appliedId: "high",
    requested: "max",
    reason: '"max" is not on this model\'s ladder (low, high) — projected by position to "high"',
  });
  assert.equal(getDesiredConfigOptions(record.acpx)?.effort, "max");
  assert.equal(getDesiredModeId(record.acpx), "high");
  assert.equal(record.acpx?.depth_projection?.requested, "max");
  assert.equal(record.acpx?.depth_projection?.outcome, "projected");
  assert.equal(record.acpx?.depth_projection?.served, "high");
  assert.ok(record.acpx?.depth_projection?.reason);
  // session_options.effort is what the acpx-ui header displays — the REQUEST, synced
  // by setDesiredConfigOption, never silently rewritten to the served rung.
  assert.equal(record.acpx?.session_options?.effort, "max");
});

test("legacy arm: a pre-B3 pi record with NO depth fields gains all three legs", () => {
  // The one-flag-flipped legacy class (change-hazards: migrating a derived writer):
  // sessions created before the depth fields existed carry none of them. A live
  // depth change must work on exactly those records — and write the same state a
  // fresh one would get.
  const record = recordFor("node /opt/pi-acp/dist/index.js");
  assert.ok(
    !JSON.stringify(record).includes("depth_projection"),
    "legacy fixture carries no depth fields",
  );
  applyDepthOutcomeToRecord(record, {
    kind: "exact",
    value: "low",
    appliedId: "low",
    requested: "low",
  });
  assert.equal(getDesiredConfigOptions(record.acpx)?.effort, "low");
  assert.equal(getDesiredModeId(record.acpx), "low");
  const written = record.acpx?.depth_projection as
    | { outcome?: string; served?: string }
    | undefined;
  assert.equal(written?.outcome, "exact");
  assert.equal(written?.served, "low");
});

test("no depth request ⇒ the record stays byte-comparable (no shape change)", () => {
  const record = recordFor("node /opt/pi-acp/dist/index.js");
  applyDepthOutcomeToRecord(record, {
    kind: "send-nothing",
    requested: "",
  });
  assert.equal(getDesiredConfigOptions(record.acpx)?.effort, undefined);
  assert.equal(record.acpx?.depth_projection, undefined);
});
