import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { persistAndApplyRequestedEffort } from "../src/session/config-option-application.js";
import type { SessionRecord } from "../src/types.js";

// F-14 (brick 06ae06c1) — the recorded served depth must come from the WIRE.
//
// ⚠️ WHAT THE DEFECT WAS, PRECISELY. `persistAndApplyRequestedEffort` wrote the
// REQUESTED level into `desired_config_options.effort`, applied it, then read
// that same field back to decide what had been served. It compared the request
// with itself, so `outcome` could only ever be `"exact"` — and it said so on both
// paths where nothing was served at all:
//
//   - the level was SKIPPED and never sent, and
//   - the agent REJECTED it and the fallback resolved back to the rejected level.
//
// ⚠️ WHY THE EXISTING SUITE COULD NOT CATCH IT: 70 depth/effort/config-option
// rows passed against the defect, because every one of them asserted the record
// AFTER a path that writes the record — the same self-comparison, one layer up.
// So each row below names the WIRE fact it is judging, never the record alone.
//
// ⚠️ SCOPE, MEASURED — THESE ROWS ARE ABOUT opencode, NOT pi. pi's depth
// mechanism is `mode` (`harness-capabilities.ts` → `pi.depth.mechanism`), so
// `persistAndApplyRequestedEffort` returns from its mode arm and NEVER reaches
// this code; pi's config option is `thought_level`, not `effort`, besides. The
// pi rows in the brick were written by `projectDepthOntoLadder` against pi's
// ADVERTISED 6-rung ladder, which is a separate defect and not this one.

const OPENCODE = AGENT_REGISTRY.opencode;

/** An advertised `effort` option — `levels` is the ladder the agent claims. */
function effortOption(currentValue: string, levels: string[]): SessionConfigOption {
  return {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue,
    options: levels.map((value) => ({ value, name: value })),
  } as SessionConfigOption;
}

function record(): SessionRecord {
  return { agentCommand: OPENCODE, acpx: {} } as unknown as SessionRecord;
}

type Wire = { configId: string; value: string };

/**
 * A stub agent whose ACKNOWLEDGEMENT can differ from what it was sent — which is
 * the whole point. `acknowledgeAs` models an agent that accepts a level and then
 * reports serving a different one, the shape the record must never call "exact".
 */
function agent(options: { acknowledgeAs?: string; rejectWith?: Error; ladder: string[] }): {
  sent: Wire[];
  setSessionConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<{ configOptions?: SessionConfigOption[] }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
} {
  const sent: Wire[] = [];
  return {
    sent,
    setSessionConfigOption(_sessionId, configId, value) {
      sent.push({ configId, value });
      if (options.rejectWith) {
        return Promise.reject(options.rejectWith);
      }
      const served = options.acknowledgeAs ?? value;
      return Promise.resolve({ configOptions: [effortOption(served, options.ladder)] });
    },
    setSessionMode() {
      return Promise.resolve();
    },
  };
}

async function applyEffort(
  rec: SessionRecord,
  client: ReturnType<typeof agent>,
  reasoningEffort: string,
  advertised: SessionConfigOption[],
): Promise<void> {
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "s1",
    record: rec,
    reasoningEffort,
    advertised,
    agentCommand: OPENCODE,
  });
}

function projection(rec: SessionRecord): Record<string, unknown> | undefined {
  return rec.acpx?.depth_projection as Record<string, unknown> | undefined;
}

test("F-14: a level the agent REJECTED is never recorded as served exactly", async () => {
  // The sharpest form of the defect. `rejectedEffortFallback` returns
  // `fallback ?? value`, and when no advertised default resolves, `value` IS the
  // level the agent just refused — so the record claimed the agent served
  // exactly the thing it said no to.
  const rec = record();
  const client = agent({ rejectWith: new Error("Invalid params"), ladder: ["low"] });
  // A single-value ladder with no `default` entry is what makes the fallback
  // resolve back to the request; that is the case being pinned.
  await applyEffort(rec, client, "low", [effortOption("high", ["low"])]);

  // CONTROL: the request genuinely reached the wire. Without this the row would
  // also pass on a build that never attempted the set at all.
  assert.equal(client.sent.length, 1, "the level was never put on the wire — row is vacuous");

  const p = projection(rec);
  assert.ok(p, "nothing was recorded for a request that was made");
  assert.notEqual(
    p.outcome,
    "exact",
    `a REJECTED level was recorded as exact: ${JSON.stringify(p)}`,
  );
  assert.equal(p.outcome, "unavailable");
  assert.equal(p.served, undefined, "a rejected level must not be recorded as served");
});

test("F-14: a level that was never SENT is not recorded as served exactly", async () => {
  // The option is advertised by id — so the outer gate opens — but it is not a
  // `select`, so `applyConfigOptionIfAdvertised` skips it and nothing reaches the
  // agent. The old re-read still returned the request and called it exact.
  const rec = record();
  const client = agent({ ladder: ["low", "high"] });
  const notSelectable = {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "text",
    currentValue: "high",
  } as unknown as SessionConfigOption;

  await applyEffort(rec, client, "high", [notSelectable]);

  assert.equal(client.sent.length, 0, "control: nothing should have been sent");
  const p = projection(rec);
  assert.ok(p, "a skipped depth request must still be recorded — never silently dropped");
  assert.equal(p.outcome, "unavailable", `recorded ${JSON.stringify(p)} for a level never sent`);
  assert.equal(p.served, undefined);
});

test("F-14: the agent's ACKNOWLEDGEMENT outranks what acpx sent", async () => {
  // The collapse case: the agent accepts the level, then reports serving a
  // different one. Its own word is the only witness, and it must win.
  const rec = record();
  const ladder = ["low", "high", "max"];
  const client = agent({ acknowledgeAs: "max", ladder });
  await applyEffort(rec, client, "high", [effortOption("low", ladder)]);

  assert.deepEqual(
    client.sent.map((c) => c.value),
    ["high"],
    "control: `high` must actually have been sent for the ack to mean anything",
  );
  const p = projection(rec);
  assert.equal(p?.outcome, "projected", `agent said "max" but acpx recorded ${JSON.stringify(p)}`);
  assert.equal(p?.served, "max");
  assert.match(String(p?.reason), /reports serving "max"/);
});

test("F-14: `exact` survives where it is TRUE — sent and acknowledged as sent", async () => {
  // The two-sided control. A fix that simply stopped saying `exact` would pass
  // every row above and be worthless; this is the row that fails if it does.
  const rec = record();
  const ladder = ["low", "high", "max"];
  const client = agent({ ladder });
  await applyEffort(rec, client, "high", [effortOption("low", ladder)]);

  const p = projection(rec);
  assert.equal(
    p?.outcome,
    "exact",
    `a genuinely served level lost its exact: ${JSON.stringify(p)}`,
  );
  assert.equal(p?.served, "high");
  assert.equal(rec.acpx?.served?.effort, "high");
});

test("F-14: `already-current` counts as served — it is the AGENT's own word", async () => {
  // No set is performed because the agent already advertises the level as
  // current. That is not acpx guessing: `currentValue` came from the agent.
  const rec = record();
  const ladder = ["low", "high", "max"];
  const client = agent({ ladder });
  await applyEffort(rec, client, "high", [effortOption("high", ladder)]);

  assert.equal(client.sent.length, 0, "control: no set should be needed");
  const p = projection(rec);
  assert.equal(p?.outcome, "exact");
  assert.equal(p?.served, "high");
});

test("F-14 ORACLE: on every canonical rung, `exact` implies the served value is ON the wire ladder", async () => {
  // The per-rung regression, with the ladder the agent advertises as the oracle.
  // This is the invariant the whole brick reduces to: acpx may serve something
  // other than what was asked, but it may never call that `exact`.
  const ladder = ["low", "high", "max"];
  const rungs = ["minimal", "low", "medium", "high", "xhigh", "max"];
  let checked = 0;
  const outcomes: Record<string, unknown> = {};

  for (const rung of rungs) {
    const rec = record();
    // The agent honours only its own ladder: anything else it reports as `low`.
    const client = agent({ ladder, acknowledgeAs: ladder.includes(rung) ? undefined : "low" });
    await applyEffort(rec, client, rung, [effortOption("low", ladder)]);
    const p = projection(rec);
    assert.ok(p, `${rung}: nothing recorded`);
    outcomes[rung] = p;
    checked += 1;
    if (p.outcome === "exact") {
      assert.ok(
        ladder.includes(String(p.served)),
        `${rung}: recorded exact with served="${String(p.served)}", which is NOT on the wire ladder ${ladder.join("/")}`,
      );
      assert.equal(p.served, rung, `${rung}: exact must mean the REQUESTED level is served`);
    }
  }

  // ⚠️ POPULATION FIRST. 0 rungs checked would satisfy every assertion above
  // vacuously and read exactly like a pass.
  assert.equal(checked, rungs.length, `only ${checked} of ${rungs.length} rungs were exercised`);
  // And the loop must not have degenerated into one answer for everything.
  const kinds = new Set(Object.values(outcomes).map((p) => (p as { outcome: string }).outcome));
  assert.ok(
    kinds.size > 1,
    `every rung produced the same outcome (${[...kinds].join(", ")}) — not discriminating`,
  );
});

test("F-14 GUARDRAIL: the Claude family still records nothing", async () => {
  // `recordDepthOutcome` is a no-op for the Claude family and must stay so —
  // their records are required to remain byte-comparable.
  const ladder = ["low", "high", "max"];
  for (const id of ["claude", "claude-pty"] as const) {
    const rec = { agentCommand: AGENT_REGISTRY[id], acpx: {} } as unknown as SessionRecord;
    const client = agent({ acknowledgeAs: "max", ladder });
    await persistAndApplyRequestedEffort({
      client,
      sessionId: "s1",
      record: rec,
      reasoningEffort: "high",
      advertised: [effortOption("low", ladder)],
      agentCommand: AGENT_REGISTRY[id],
    });
    assert.equal(projection(rec), undefined, `${id} gained a depth_projection`);
  }
});
