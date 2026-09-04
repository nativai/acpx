import assert from "node:assert/strict";
import test from "node:test";
import type { SessionModeState } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { applyDepthAsMode, recordDepthOutcome } from "../src/session/depth-application.js";
import {
  CANONICAL_DEPTH_RUNGS,
  CANONICAL_DEPTH_VOCABULARY,
  projectDepthOntoLadder,
} from "../src/session/depth-projection.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// B3 deliverables 2 + 4 — the canonical vocabulary, the projection rule
// (CONCEPTION §6.2), and the ACP mode arm for Pi (I2 R8).

// ── The vocabulary ───────────────────────────────────────────────────────────

test("the canonical vocabulary is the one acpx-ui already validates", () => {
  assert.deepEqual(
    [...CANONICAL_DEPTH_RUNGS],
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(
    [...CANONICAL_DEPTH_VOCABULARY],
    ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
});

test("default and off are DIFFERENT requests, and the difference is load-bearing", () => {
  // 97 catalogue models are reasoning.mandatory, so `off` is unsatisfiable for
  // them while `default` always is. Collapsing the two would make acpx claim it
  // disabled reasoning on a model that cannot disable it.
  const mandatoryLadder = ["low", "high", "max"]; // no off-rung
  assert.equal(projectDepthOntoLadder("default", mandatoryLadder).kind, "send-nothing");
  const off = projectDepthOntoLadder("off", mandatoryLadder);
  assert.equal(off.kind, "clamped");
  assert.equal(off.value, "low");
  assert.match(off.reason ?? "", /cannot be disabled/);
});

// ── The projection rule ──────────────────────────────────────────────────────

test("an exact name match is used verbatim and records no substitution", () => {
  const projection = projectDepthOntoLadder("high", ["low", "medium", "high"]);
  assert.equal(projection.kind, "exact");
  assert.equal(projection.value, "high");
  assert.equal(projection.reason, undefined);
});

test("an off-rung is used when the ladder has one", () => {
  for (const offName of ["none", "off", "disabled"]) {
    const projection = projectDepthOntoLadder("off", [offName, "low", "high"]);
    assert.equal(projection.kind, "off", offName);
    assert.equal(projection.value, offName);
  }
});

test("projection by position is L[round(i/6 x (|L|-1))], monotone and total", () => {
  // Measured OpenCode ladder for z-ai/glm-5.3-flash (I1 R8).
  const ladder = ["low", "high", "max"]; // |L| = 3, so indices 0..2
  const landed = CANONICAL_DEPTH_RUNGS.map((rung, index) => {
    const projection = projectDepthOntoLadder(rung, ladder);
    // Every canonical rung must land somewhere — the rule is TOTAL.
    assert.ok(projection.value, `${rung} did not project`);
    assert.equal(projection.kind, ladder.includes(rung) ? "exact" : "projected");
    return [rung, index, projection.value] as const;
  });
  assert.deepEqual(
    landed.map(([, , value]) => value),
    // minimal(0)->0, low(1)->0(exact), medium(2)->1, high(3)->1(exact),
    // xhigh(4)->1, max(5)->2(exact), ultra(6)->2
    ["low", "low", "high", "high", "high", "max", "max"],
  );
  // MONOTONE: a stronger request never lands on a weaker rung.
  const ranks = landed.map(([, , value]) => ladder.indexOf(value ?? ""));
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok(ranks[i] >= ranks[i - 1], "projection is not monotone");
  }
});

test("a substitution is always RECORDED, never silent", () => {
  const projection = projectDepthOntoLadder("ultra", ["low", "medium", "high"]);
  assert.equal(projection.kind, "projected");
  assert.equal(projection.requested, "ultra");
  assert.ok(projection.reason, "a substitution with no reason is a silent drop");
  assert.match(projection.reason ?? "", /projected by position/);
});

test("a model with no ladder is UNAVAILABLE WITH A REASON, never silently absent", () => {
  const projection = projectDepthOntoLadder("high", []);
  assert.equal(projection.kind, "unavailable");
  assert.equal(projection.value, undefined);
  assert.ok(projection.reason, "an unavailable control with no reason is the defect, not the fix");
});

test("every canonical request against every measured ladder yields a named outcome", () => {
  // The completeness sweep: no input may produce an outcome that says nothing.
  const measuredLadders = [
    ["low", "high", "max"], // opencode z-ai/glm-5.3-flash (I1 R8)
    ["low", "medium", "high"], // opencode anthropic/claude-haiku-4.5 (I1 R8)
    ["off", "minimal", "low", "medium", "high", "xhigh"], // pi ACP modes (I2 R8)
    [], // a non-reasoning model
  ];
  for (const ladder of measuredLadders) {
    for (const request of CANONICAL_DEPTH_VOCABULARY) {
      const projection = projectDepthOntoLadder(request, ladder);
      const where = `${request} on [${ladder.join(",")}]`;
      assert.ok(projection.kind, `${where} produced no outcome`);
      assert.equal(projection.requested, request);
      // The invariant, stated as a check: either a value was chosen, or a reason
      // explains why none was. Never neither.
      assert.ok(
        projection.value !== undefined ||
          projection.reason !== undefined ||
          projection.kind === "send-nothing",
        `${where} was SILENTLY DROPPED`,
      );
    }
  }
});

// ── The mode arm (Pi) ────────────────────────────────────────────────────────

function piModes(currentModeId = "medium"): SessionModeState {
  return {
    currentModeId,
    availableModes: ["off", "minimal", "low", "medium", "high", "xhigh"].map((id) => ({
      id,
      name: id,
    })),
  } as unknown as SessionModeState;
}

function modeClient(reject?: Error): {
  sent: string[];
  setSessionMode: (s: string, m: string) => Promise<void>;
} {
  const sent: string[] = [];
  return {
    sent,
    setSessionMode(_sessionId, modeId) {
      sent.push(modeId);
      return reject ? Promise.reject(reject) : Promise.resolve();
    },
  };
}

test("a depth request reaches Pi through session/set_mode", async () => {
  const client = modeClient();
  const projection = await applyDepthAsMode({
    client,
    sessionId: "ses_pi",
    requested: "high",
    modes: piModes(),
  });
  assert.equal(projection.kind, "exact");
  assert.deepEqual(client.sent, ["high"]);
});

test("an ADVERTISED-then-REJECTED mode is a recorded failure, NOT a silent retry", async () => {
  // pi-acp advertises `max` and answers -32602 for it (I2 R8) — the advertisement
  // itself is wrong. Retrying a lower rung would serve a depth the user did not
  // ask for and record it as success.
  const client = modeClient(new Error("Invalid params (ACP -32602)"));
  const projection = await applyDepthAsMode({
    client,
    sessionId: "ses_pi",
    requested: "xhigh",
    modes: piModes(),
  });
  assert.equal(projection.kind, "unavailable");
  assert.match(projection.reason ?? "", /ADVERTISED/);
  assert.match(projection.reason ?? "", /-32602/);
  assert.match(projection.reason ?? "", /does not silently retry/);
  assert.equal(client.sent.length, 1, "exactly one attempt — a retry would be a second send");
});

test("Pi's 6-rung ladder is a 3-VALUE WIRE ladder, and off is not off", async () => {
  // I2 R8, measured at the wire through a logging proxy. acpx sends the advertised
  // mode id; Pi collapses it. The UI must not imply six distinct levels exist.
  const collapse: Record<string, string> = {
    off: "low",
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
    xhigh: "max",
  };
  const distinctWireValues = new Set(Object.values(collapse));
  assert.equal(distinctWireValues.size, 3, "six advertised rungs, three wire behaviours");
  assert.equal(collapse.off, "low", "off sends low — a Pi session CANNOT disable reasoning");

  // And the projection genuinely reaches the advertised `off` rung, so the
  // not-actually-off behaviour is Pi's, not a projection error on our side.
  const client = modeClient();
  const projection = await applyDepthAsMode({
    client,
    sessionId: "ses_pi",
    requested: "off",
    modes: piModes(),
  });
  assert.equal(projection.kind, "off");
  assert.deepEqual(client.sent, ["off"]);
});

test("no wire call when the session is already at the projected mode", async () => {
  const client = modeClient();
  const projection = await applyDepthAsMode({
    client,
    sessionId: "ses_pi",
    requested: "medium",
    modes: piModes("medium"),
  });
  assert.equal(projection.kind, "exact");
  assert.deepEqual(client.sent, []);
});

// ── Recording the outcome ────────────────────────────────────────────────────

function recordFor(agentCommand: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "rec-depth",
    acpSessionId: "rec-depth-acp",
    agentCommand,
    cwd: "/workspace/projects/temp",
  });
}

test("a non-exact outcome is recorded on the record, with request AND served", async () => {
  const record = recordFor(AGENT_REGISTRY.pi);
  recordDepthOutcome(record, projectDepthOntoLadder("ultra", ["low", "medium", "high"]));
  assert.equal(record.acpx?.depth_projection?.requested, "ultra");
  assert.equal(record.acpx?.depth_projection?.outcome, "projected");
  assert.equal(record.acpx?.depth_projection?.served, "high");
  assert.ok(record.acpx?.depth_projection?.reason);
  assert.equal(record.acpx?.served?.effort, "high");
  assert.equal(record.acpx?.served?.source, "depth-projection");
});

test("an UNAVAILABLE outcome is recorded even though no value was sent", async () => {
  // The invariant: a depth request is never silently dropped. This is the case
  // the `served` block alone cannot express, which is why depth_projection exists.
  const record = recordFor(AGENT_REGISTRY.pi);
  recordDepthOutcome(record, projectDepthOntoLadder("high", []));
  assert.equal(record.acpx?.depth_projection?.outcome, "unavailable");
  assert.equal(record.acpx?.depth_projection?.requested, "high");
  assert.equal(record.acpx?.depth_projection?.served, undefined);
  assert.ok(record.acpx?.depth_projection?.reason, "an unavailable outcome must carry its reason");
});

test("GUARDRAIL: the Claude family record is NOT touched by the depth recorder", async () => {
  // `served` there belongs to the Claude-transcript producer, whose `effort`
  // means something different and which would overwrite this on the next turn.
  for (const id of ["claude", "claude-pty"] as const) {
    const record = recordFor(AGENT_REGISTRY[id]);
    const before = JSON.stringify(record);
    recordDepthOutcome(record, projectDepthOntoLadder("ultra", ["low", "high"]));
    assert.equal(JSON.stringify(record), before, `${id}: the record was modified`);
    assert.equal(record.acpx?.depth_projection, undefined, id);
  }
});

test("the recorder MERGES into served and never destroys a sibling model write", async () => {
  const record = recordFor(AGENT_REGISTRY.opencode);
  record.acpx = { ...record.acpx, served: { model: "openrouter/deepseek/deepseek-v4-pro" } };
  recordDepthOutcome(record, projectDepthOntoLadder("high", ["low", "medium", "high"]));
  assert.equal(
    record.acpx?.served?.model,
    "openrouter/deepseek/deepseek-v4-pro",
    "setServedState REPLACES the block; this recorder must MERGE",
  );
  assert.equal(record.acpx?.served?.effort, "high");
});

test("the depth outcome SURVIVES the per-turn acpx-state clone", async () => {
  // ⚠️ THE LEG A REAL RIG TURN CAUGHT AND EVERY IN-MEMORY TEST MISSED.
  //
  // `cloneSessionAcpxState` is an explicit ALLOWLIST, and the turn path re-bases
  // `record.acpx` off its result. A field it does not name is dropped on EVERY
  // REAL TURN — silently, with typecheck and the unit suite green. B3 shipped
  // with the parse and index legs done and this one missed: on the rig the field
  // was present at `sessions new` and NULL after one prompt, and the index entry
  // was null with it.
  //
  // This asserts the PROPERTY (the value survives a clone) rather than that a
  // name appears in a source file — a source-text check survives its own
  // violation, because a leftover comment keeps the string present.
  const acpx = {
    depth_projection: {
      requested: "ultra",
      outcome: "projected",
      served: "high",
      reason: "projected by position",
    },
    served: { effort: "high", source: "depth-projection" },
  } as unknown as NonNullable<SessionRecord["acpx"]>;

  const cloned = cloneSessionAcpxState(acpx);
  assert.deepEqual(
    cloned?.depth_projection,
    acpx.depth_projection,
    "the depth outcome was dropped by the per-turn clone",
  );
  // Its sibling must survive too — if `served` were also dropped this test would
  // be measuring a broken clone rather than a missing field.
  assert.deepEqual(cloned?.served, acpx.served, "control: served must survive the same clone");
  // And it is a COPY, not the same object: a shared reference would let a later
  // mutation of the clone rewrite the record's own breadcrumb.
  assert.notEqual(cloned?.depth_projection, acpx.depth_projection);
});

test("an outcome that served NOTHING must not write a served block", async () => {
  // ⚠️ FOUND AFTER MERGE, by asking "is anything unreported?" and re-reading the
  // rig record instead of recalling it.
  //
  // `served` is ABSENT for codex on this build — a MEASURED baseline the
  // programme relies on (RIG.md §9.4 finding 4; the B3 brief repeats it). And
  // `--reasoning-effort` on codex ALWAYS lands in the `unavailable` arm, because
  // codex depth is fused into the model id. Writing `served` unconditionally
  // therefore gave every such session a block carrying only `{at, source}` — no
  // model, no effort — i.e. an assertion of served truth where nothing was served.
  const record = recordFor(AGENT_REGISTRY.codex);
  recordDepthOutcome(record, projectDepthOntoLadder("xhigh", []));
  assert.equal(record.acpx?.served, undefined, "a served block was written for an unserved depth");
  // The outcome is NOT lost — that is the whole reason depth_projection exists.
  assert.equal(record.acpx?.depth_projection?.outcome, "unavailable");
  assert.equal(record.acpx?.depth_projection?.requested, "xhigh");
  assert.ok(record.acpx?.depth_projection?.reason);

  // POSITIVE CONTROL, same instrument: an outcome that DID serve a value still
  // writes it. Without this, "no served block" would also pass if the writer were
  // broken outright.
  const served = recordFor(AGENT_REGISTRY.pi);
  recordDepthOutcome(served, projectDepthOntoLadder("high", ["low", "medium", "high"]));
  assert.equal(served.acpx?.served?.effort, "high");
  assert.equal(served.acpx?.served?.source, "depth-projection");
});
