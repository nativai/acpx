import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LastTurnProviderBreadcrumb } from "../src/acp/openrouter-attribution.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { removeTempHomeSync } from "./temp-home.js";

// Finding PM-1 — a Claude/OpenRouter session's FIRST turn recorded `null` on the
// record AND the index although the shim's log held the provider (4/4 fresh
// sessions in the post-merge smoke; turn 2 "self-corrected").
//
// 🛑 THE MECHANISM WAS NOT A RACE, AND THE EARLIER FIX (F-3) TREATED THE WRONG
// CAUSE. In the smoke the shim's line was on disk **3.1 s before** the clobbering
// write. Traced here with per-object identity on every serialize:
//
//   13:20:30.582  write  provider="Wafer"   ← on disk, correct
//   13:20:30.589  read   onDisk=null        ← THE PARSER DROPPED IT, 7 ms later
//   13:20:30.590  write  provider=null      ← and the loss is written straight back
//
// `parseSessionRecord` is an ALLOWLIST and `last_turn_provider` was not on it —
// the fourth field in this repo eaten by one (`applied_output_style`, `served`,
// `depth_projection` before it). The value was written correctly every time and
// destroyed by the next reader, which hands its parsed record back to a writer.
//
// ⚠️ WHY F-3's 3/3 WAS REAL AND STILL PROVED NOTHING: where no later writer
// happens to run, the on-disk value survives to the poll. The bug is therefore
// INVISIBLE in a rig with no late write and present in production, where the
// close path always runs. A round-trip row — this one — could not have missed it.

const WAFER: LastTurnProviderBreadcrumb = {
  provider_name: "Wafer",
  native_finish_reason: null,
  response_id: null,
  at: "2026-09-10T13:20:30.582Z",
};

function recordWith(provider?: LastTurnProviderBreadcrumb): SessionRecord {
  const record = makeSessionRecord({
    acpxRecordId: "pm1-1",
    acpSessionId: "acp-pm1-1",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/x",
  });
  if (provider) {
    record.acpx = { ...record.acpx, last_turn_provider: provider };
  }
  return record;
}

/** What a writer does to a record it just read: serialize → parse → serialize. */
function roundTrip(record: SessionRecord): SessionRecord | null {
  return parseSessionRecord(JSON.parse(JSON.stringify(serializeSessionRecordForDisk(record))));
}

test("PM-1 · last_turn_provider survives serialize → parse — the leg that was missing", () => {
  const parsed = roundTrip(recordWith(WAFER));
  assert.deepEqual(parsed?.acpx?.last_turn_provider, WAFER);
});

test("PM-1 · and it survives a SECOND round trip — the write-back that persisted the loss", () => {
  // The single round trip above would pass even if a later transform dropped it.
  // The defect was that a reader's record goes straight back to a writer, so the
  // property that matters is that the value is still there after read → write → read.
  const once = roundTrip(recordWith(WAFER));
  assert.ok(once);
  const twice = roundTrip(once);
  assert.deepEqual(twice?.acpx?.last_turn_provider, WAFER);
});

test("PM-1 · a present-and-NULL provider round-trips too — null is meaningful here", () => {
  // `null` means "observed, but the response named none" and is different from
  // absent ("not recorded"). A parser that dropped the block on a null
  // provider_name would collapse the two states the whole feature rests on.
  const observed: LastTurnProviderBreadcrumb = {
    provider_name: null,
    native_finish_reason: null,
    response_id: null,
    at: "2026-09-10T13:20:30.582Z",
  };
  const parsed = roundTrip(recordWith(observed));
  assert.deepEqual(parsed?.acpx?.last_turn_provider, observed);
});

test("PM-1 · a malformed block is dropped rather than half-parsed", () => {
  // `at` is required: a breadcrumb a reader cannot place in time is worse than
  // none, because it reads as current.
  const record = recordWith();
  const onDisk = serializeSessionRecordForDisk(record);
  onDisk.acpx = { last_turn_provider: { provider_name: "Wafer" } };
  const parsed = parseSessionRecord(JSON.parse(JSON.stringify(onDisk)));
  assert.equal(parsed?.acpx?.last_turn_provider, undefined);
});

test("PM-1 · an absent record stays absent — the parser invents nothing", () => {
  const parsed = roundTrip(recordWith());
  assert.equal(parsed?.acpx?.last_turn_provider, undefined);
});

// ── the second leg: the write-path preserve ──────────────────────────────────
//
// ⚠️ HONEST STATUS: this leg did NOT fire in the live regression. With the parse
// leg above in place, every late writer's record already carries the value, so
// `fired:false` on all three of the traced final writes. It is kept because it
// covers a case the parse leg cannot — a writer holding a record object parsed
// BEFORE the turn produced the attribution (a long-lived in-memory record, e.g.
// SessionEventWriter's) — and because "unreachable today" is not "unreachable".
// It is tested here rather than trusted, so it cannot become untested dead code.

test("PM-1 · a STALE in-memory record does not erase what is already on disk", async () => {
  const { readPersistedLifecycle, writeSessionRecord } =
    await import("../src/session/persistence.js");
  const home = mkdtempSync(path.join(os.tmpdir(), "acpx-pm1-preserve-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  try {
    // 1. a turn writes the provider
    const fresh = recordWith(WAFER);
    await writeSessionRecord(fresh);
    assert.equal(
      (await readPersistedLifecycle("pm1-1"))?.acpx?.last_turn_provider?.provider_name,
      "Wafer",
      "precondition: the value is on disk",
    );

    // 2. a writer holding a record from BEFORE that turn flushes its own copy
    const stale = recordWith();
    assert.equal(stale.acpx?.last_turn_provider, undefined, "the stale copy has none");
    await writeSessionRecord(stale);

    // 3. the on-disk value must have survived the stale flush
    assert.equal(
      (await readPersistedLifecycle("pm1-1"))?.acpx?.last_turn_provider?.provider_name,
      "Wafer",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    removeTempHomeSync(home);
  }
});

test("PM-1 · but a NEWER in-memory value still wins — the preserve is one-directional", async () => {
  // A later turn must be able to change the provider; disk only fills an ABSENCE.
  // Driven through the real write path, not asserted on a local expression: the
  // property belongs to the product, and a row that re-implements the merge would
  // pass on a build where the merge is backwards.
  const { readPersistedLifecycle, writeSessionRecord } =
    await import("../src/session/persistence.js");
  const home = mkdtempSync(path.join(os.tmpdir(), "acpx-pm1-newer-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  try {
    await writeSessionRecord(recordWith(WAFER));
    await writeSessionRecord(
      recordWith({
        provider_name: "BaseTen",
        native_finish_reason: null,
        response_id: null,
        at: "2026-09-10T14:00:00.000Z",
      }),
    );
    const after = await readPersistedLifecycle("pm1-1");
    assert.equal(after?.acpx?.last_turn_provider?.provider_name, "BaseTen");
    assert.equal(after?.acpx?.last_turn_provider?.at, "2026-09-10T14:00:00.000Z");
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    removeTempHomeSync(home);
  }
});
