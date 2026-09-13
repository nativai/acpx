import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { deriveCostFigure, priceUnit } from "../src/models/cost-provenance.js";
import { assertPersistedKeyPolicy } from "../src/persisted-key-policy.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import { rememberSessionCost } from "../src/session/cost-ingest.js";
import { LiveSessionCheckpoint } from "../src/session/live-checkpoint.js";
import {
  flushPendingSessionIndexUpdates,
  parseSessionRecord,
  writeSessionRecord,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

const COUNTS = { input: 490, cacheRead: 282752, cacheWrite: 0, output: 521, reasoning: 410 };

function record(): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "usage-unit-persistence",
    acpSessionId: "codex-thread",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    cwd: process.cwd(),
    acpx: { current_model_id: "session-fallback" },
  });
}

function usage(meta: Record<string, unknown>, size = 0): SessionNotification {
  return {
    sessionId: "codex-thread",
    update: { sessionUpdate: "usage_update", used: 999999, size, _meta: meta },
  } as SessionNotification;
}

function fold(target: SessionRecord, notification: SessionNotification): void {
  const conversation = createSessionConversation();
  recordPromptSubmission(conversation, "Inspect a file, then explain the result.");
  target.acpx = recordSessionUpdate(conversation, target.acpx, notification, undefined, {
    promptEverSubmitted: true,
  });
  target.messages = conversation.messages;
  target.updated_at = conversation.updated_at;
}

async function diskRecord(home: string, target: SessionRecord): Promise<SessionRecord> {
  const raw: unknown = JSON.parse(
    await fs.readFile(sessionFilePath(home, target.acpxRecordId), "utf8"),
  );
  assertPersistedKeyPolicy(raw);
  const parsed = parseSessionRecord(raw);
  assert.ok(parsed, "the entire record must parse after the real write");
  return parsed;
}

async function checkpoint(target: SessionRecord): Promise<void> {
  const live = new LiveSessionCheckpoint({ save: () => writeSessionRecord(target) });
  live.request();
  await live.flush();
  await flushPendingSessionIndexUpdates();
}

test("neutral usage survives checkpoint, null pricing, model switch and cold-resume append", async () => {
  await withTempHome("acpx-usage-units-", async (home) => {
    let target = record();
    await checkpoint(target);
    const before = Date.now();
    fold(
      target,
      usage({
        acpxUsage: { unit: { ...COUNTS, model: "gpt-6-astra", ts: "1900-01-01", sequence: 1 } },
        piAcp: { message: { input: 12345, output: 54321 } },
      }),
    );
    await checkpoint(target);
    target = await diskRecord(home, target);
    const first = target.acpx?.cost_units?.[0];
    assert.ok(first);
    assert.deepEqual(first, {
      input: 490,
      output: 521,
      reasoning: 410,
      cache_read: 282752,
      cache_write: 0,
      rates: null,
      cost_usd: null,
      model: "gpt-6-astra",
      ts: first.ts,
      provider_name: null,
      native_finish_reason: null,
      // Stamped unconditionally by `attributionFields` (cost-ingest.ts) — `null`
      // whenever the update carries no attribution, as here. Landed on dev in
      // brick 77054e85 after this test was written against the pre-merge shape.
      response_id: null,
    });
    assert.ok(Date.parse(first.ts ?? "") >= before);
    assert.ok(Date.parse(first.ts ?? "") <= Date.now());
    assert.equal(target.acpx?.context_window_size, undefined, "size:0 must not suppress usage");
    assert.equal(target.closed, false);
    assert.deepEqual(target.acpx?.cost, {
      amount: null,
      currency: "USD",
      provenance: "unpriced",
      coverage: { unit: "message", priced: 0, total: 1 },
    });

    const originalBytes = JSON.stringify(first);
    target.acpx = cloneSessionAcpxState(target.acpx);
    assert.ok(target.acpx);
    target.acpx.current_model_id = "different-session-fallback";
    // Cold parse + clone precede the next adapter delta. Its counters reset and
    // its model differs from BOTH the previous unit and the session fallback.
    fold(
      target,
      usage({
        acpxUsage: {
          unit: {
            model: "gpt-5.3-codex-spark",
            input: 7,
            output: 9,
            cacheRead: 3,
            cacheWrite: 2,
            reasoning: 0,
          },
        },
      }),
    );
    await checkpoint(target);
    target = await diskRecord(home, target);
    assert.equal(target.acpx?.cost_units?.length, 2);
    assert.equal(JSON.stringify(target.acpx?.cost_units?.[0]), originalBytes);
    assert.equal(target.acpx?.cost_units?.[1].model, "gpt-5.3-codex-spark");
    assert.equal(target.acpx?.cost_units?.[1].reasoning, 0);
    assert.equal(target.acpx?.cost_units?.[1].input, 7);
    assert.deepEqual(target.acpx?.cost?.coverage, { unit: "message", priced: 0, total: 2 });
    assert.equal(target.acpx?.cost?.amount, null);
    assert.equal(target.acpx?.cost?.currency, "USD");
  });
});

test("legacy Pi fallback and legacy units retain their shape through cold append", async () => {
  await withTempHome("acpx-usage-pi-", async (home) => {
    let target = record();
    const legacy = { input: 1, output: 2, cache_read: 3, cache_write: 4, rates: null };
    target.acpx = { current_model_id: "legacy-pi-model", cost_units: [legacy] };
    await checkpoint(target);
    target = await diskRecord(home, target);
    fold(
      target,
      usage(
        { piAcp: { message: { input: 3161, output: 26, cacheRead: 4740, cacheWrite: 0 } } },
        262144,
      ),
    );
    await checkpoint(target);
    target = await diskRecord(home, target);
    assert.deepEqual(target.acpx?.cost_units?.[0], legacy);
    assert.equal(target.acpx?.cost_units?.[1].model, "legacy-pi-model");
    assert.equal(target.acpx?.cost_units?.[1].input, 3161);
    assert.equal(target.acpx?.cost_units?.[1].output, 26);
    assert.equal(Object.hasOwn(target.acpx?.cost_units?.[1] ?? {}, "reasoning"), false);
    assert.equal(target.acpx?.context_window_size, 262144);
    const units = structuredClone(target.acpx?.cost_units);
    fold(target, usage({}));
    await checkpoint(target);
    assert.deepEqual((await diskRecord(home, target)).acpx?.cost_units, units);
  });
});

test("observed model selects rates and reasoning never adds to price or derived total", async () => {
  await withTempHome("acpx-usage-price-", async (home) => {
    const target = record();
    const acpx = cloneSessionAcpxState(target.acpx);
    assert.ok(acpx);
    const seen: string[] = [];
    rememberSessionCost(
      acpx,
      { ...COUNTS, model: "observed-model" },
      (model) => {
        seen.push(model);
        return {
          in_per_m: 2,
          out_per_m: 8,
          cache_read_per_m: 1,
          cache_write_per_m: 4,
          measured_free: false,
        };
      },
      () => new Date("2026-09-11T01:02:03.004Z"),
    );
    target.acpx = acpx;
    await checkpoint(target);
    const persisted = await diskRecord(home, target);
    const unit = persisted.acpx?.cost_units?.[0];
    assert.ok(unit);
    assert.deepEqual(seen, ["observed-model"]);
    assert.equal(unit.ts, "2026-09-11T01:02:03.004Z");
    const expected = (490 * 2 + 282752 + 521 * 8) / 1_000_000;
    assert.equal(unit.cost_usd, expected);
    assert.equal(persisted.acpx?.cost?.amount, expected);
    assert.equal(priceUnit({ ...unit, reasoning: 0 }), priceUnit(unit));
    assert.deepEqual(deriveCostFigure([{ ...unit, reasoning: 0 }]), deriveCostFigure([unit]));
  });
});

test("CONTROL: a forbidden unit key rejects checkpoint and freezes the previous disk bytes", async () => {
  await withTempHome("acpx-usage-bad-key-", async (home) => {
    const target = record();
    await checkpoint(target);
    const file = sessionFilePath(home, target.acpxRecordId);
    const before = await fs.readFile(file, "utf8");
    fold(target, usage({ acpxUsage: { unit: { ...COUNTS, model: "gpt-6-astra" } } }));
    const unit = target.acpx?.cost_units?.[0];
    assert.ok(unit, "positive control: the fold created a unit");
    Object.assign(unit, { reasoningTokens: 410 });
    const live = new LiveSessionCheckpoint({ save: () => writeSessionRecord(target) });
    await assert.rejects(live.checkpoint(), /Persisted key policy violation.*reasoningTokens/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.equal((await diskRecord(home, target)).acpx?.cost_units, undefined);
    await flushPendingSessionIndexUpdates();
  });
});
