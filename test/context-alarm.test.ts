/**
 * THE CONTEXT ALARM — brick 4f3fa88c (Daniel's decision, brick 7f61daf9 DECISION.md A–D).
 *
 * Rows map to CONCEPTION.md §5 as amended by DECISION.md:
 *   row 3 — a window whose harness compacts at or below 90 % + runway: the default rings
 *           BEFORE compaction with at least the runway left;
 *   row 4 — every later turn opens with the line, fresh numbers;
 *   row 5 — `--alarm 0` ⇒ no notice in the crossing turn or any later one;
 *   row 6 — the level is the SEAT's: a successor shows it, a child shows the default;
 *   row 8 — unknown window ⇒ 0, usage 0 %, no alarm;
 * plus once-per-crossing with re-arm, and the mid-turn delivery through the real runtime.
 * Rows 1, 2, 7 and 9 need real agents — the independent TE's, on devbox-staging.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AcpClient } from "../src/acp/client.js";
import { buildTurnContextRequest, resolveTurnContext } from "../src/acp/turn-context.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { type PromptInput, textPrompt } from "../src/prompt-content.js";
import {
  ContextAlarmDetector,
  handoverBelowAlarmNote,
  registerContextAlarmDetector,
} from "../src/session/context-alarm-detector.js";
import {
  CONTEXT_ALARM_MARKER,
  ContextAlarmLatch,
  type ContextAlarmEvent,
  type ContextFill,
  contextUsedPct,
  formatContextAlarmClearedNotice,
  formatContextAlarmNotice,
  formatContextLine,
  parseContextAlarmArgument,
  resolveContextAlarm,
} from "../src/session/context-alarm.js";
import { recordSessionUpdate } from "../src/session/conversation-model.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import { resolveSessionRecord, sessionBaseDir } from "../src/session/persistence/repository.js";
import {
  mintSeatRow,
  parseSeatStore,
  readSeatStore,
  seatFromStore,
  setSeatContextAlarm,
} from "../src/session/persistence/seat-store.js";
import type { SessionContextFill, SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const fill = (used: number, window: number, compactAt?: number): ContextFill => ({
  used,
  window,
  compactAt,
});

// ─── B · the level, the runway, the compaction point ─────────────────────────

test("1M Claude: the default IS Daniel's 90 % (compaction at 967,000 is far enough)", () => {
  const alarm = resolveContextAlarm(undefined, fill(0, 1_000_000, 967_000));
  assert.equal(alarm.atTokens, 900_000);
  assert.equal(alarm.movedForRunway, false);
});

test("row 3 — 200k Claude (compacts at 167,000 = 83.5 %): the default rings at 147,000, a 20,000 runway before compaction", () => {
  const alarm = resolveContextAlarm(undefined, fill(0, 200_000, 167_000));
  assert.equal(alarm.atTokens, 147_000);
  assert.equal(alarm.movedForRunway, true);
  assert.ok(167_000 - (alarm.atTokens ?? Infinity) >= 20_000);
  // A literal 90 % (180,000) would ring AFTER compaction — the negative case.
  assert.ok(Math.floor(200_000 * 0.9) > 167_000);
});

test("row 3 — pi 128k (compacts at 111,616 = 87.2 %): the default rings at 98,816 with the 12,800 runway", () => {
  const alarm = resolveContextAlarm(undefined, fill(0, 128_000, 128_000 - 16_384));
  assert.equal(alarm.atTokens, 98_816);
  assert.equal(111_616 - (alarm.atTokens ?? 0), 12_800);
});

test("codex at our configured 784,800 on an 828,400 window: rings at 744,800", () => {
  assert.equal(resolveContextAlarm(undefined, fill(0, 828_400, 784_800)).atTokens, 744_800);
});

test("an EXPLICIT level is honoured as given — past the compaction point it warns, it is not clamped", () => {
  // pi 1M compacts at 1,032,192 (98.4 %); 99 % = 1,038,090 sits past it.
  const alarm = resolveContextAlarm(99, fill(0, 1_048_576, 1_032_192));
  assert.equal(alarm.atTokens, 1_038_090);
  assert.equal(alarm.pastCompaction, true);
  assert.match(formatContextLine(fill(0, 1_048_576, 1_032_192), alarm), /alarm 99 % at 1,038,090/);
  // Control: an explicit level before compaction carries no warning.
  assert.equal(resolveContextAlarm(75, fill(0, 1_048_576, 1_032_192)).pastCompaction, false);
});

test("no compaction point reported ⇒ the plain level, no clamp", () => {
  assert.equal(resolveContextAlarm(undefined, fill(0, 200_000)).atTokens, 180_000);
});

test("row 5 — level 0 is off: never rings", () => {
  const alarm = resolveContextAlarm(0, fill(0, 1_000_000, 967_000));
  assert.equal(alarm.atTokens, undefined);
  assert.equal(
    new ContextAlarmLatch().observe(fill(999_999, 1_000_000, 967_000), alarm),
    undefined,
  );
});

test("row 8 — unknown window (0): usage 0 %, no alarm, and no 'unconfirmed' wording", () => {
  const unknown = fill(180_089, 0);
  const alarm = resolveContextAlarm(undefined, unknown);
  assert.equal(alarm.atTokens, undefined);
  assert.equal(contextUsedPct(unknown), 0);
  assert.equal(new ContextAlarmLatch().observe(unknown, alarm), undefined);
  const line = formatContextLine(unknown, alarm);
  assert.match(line, /180,089 \/ 0 tokens \(0\.0 %\)/);
  assert.doesNotMatch(line, /unconfirm|unknown|guess/i);
});

test("--alarm accepts 0-100 and default, nothing else", () => {
  assert.equal(parseContextAlarmArgument("75"), 75);
  assert.equal(parseContextAlarmArgument("0"), 0);
  assert.equal(parseContextAlarmArgument("default"), undefined);
  for (const bad of ["101", "-1", "90.5", "ninety", "", "1e2"]) {
    assert.throws(() => parseContextAlarmArgument(bad), /whole percentage 0-100/);
  }
});

// ─── C · once per crossing, re-armed when the fill drops back ────────────────

test("once per crossing: speaks on the crossing update only, re-arms after the fill drops back", () => {
  const latch = new ContextAlarmLatch();
  const alarm = resolveContextAlarm(undefined, fill(0, 1_000_000, 967_000));
  const spoke = [850_000, 905_000, 930_000, 950_000, 12_000, 400_000, 910_000].map((used) =>
    latch.observe(fill(used, 1_000_000, 967_000), alarm),
  );
  assert.deepEqual(spoke, [
    undefined,
    "crossed",
    undefined,
    undefined,
    "cleared",
    undefined,
    "crossed",
  ]);
});

// D2 (TE 4c8a82db, verification-evidence/codex-errhigh-probe.txt) — the REAL report sequence
// of one codex turn at `--alarm 4` (33,136 of an 828,400 window, codex compacting at 40,000).
// Err-high charges cross the alarm and the next report corrects them back below it; a latch
// that re-arms on any dip spoke FIVE times for TWO real crossings (one before the compaction
// at 37,152 → 16,106, one after it).
const TE_CODEX_INTERLEAVING = [
  21_704, 21_811, 22_183, 53_467, 29_390, 29_497, 29_899, 61_128, 37_152, 16_106, 16_510, 47_647,
  22_432, 22_790, 23_148, 23_255, 23_688, 54_965, 30_537, 30_895, 31_253, 31_360, 31_790, 32_288,
  37_891, 40_024, 17_602, 17_913, 23_882,
];

test("D2 — an estimate correcting itself is not the fill dropping back: one notice per real crossing", () => {
  const latch = new ContextAlarmLatch();
  const alarm = resolveContextAlarm(4, fill(0, 828_400, 40_000));
  assert.equal(alarm.atTokens, 33_136);
  const spokeAt = TE_CODEX_INTERLEAVING.filter(
    (used) => latch.observe(fill(used, 828_400, 40_000), alarm) === "crossed",
  );
  assert.deepEqual(spokeAt, [53_467, 47_647]);
});

test("D2 — re-arm rule: only a drop below HALF the alarm point (a compaction, /compact) re-arms; off/unknown re-arms too", () => {
  const alarm = resolveContextAlarm(undefined, fill(0, 1_000_000, 967_000)); // 900,000
  const latch = new ContextAlarmLatch();
  const spoke = (used: number, a = alarm) => latch.observe(fill(used, 1_000_000, 967_000), a);
  assert.equal(spoke(905_000), "crossed");
  assert.equal(spoke(880_000), undefined); // an estimate corrected down: NOT re-armed
  assert.equal(spoke(920_000), undefined);
  assert.equal(spoke(450_001), undefined); // still above half
  assert.equal(spoke(910_000), undefined);
  assert.equal(spoke(449_999), "cleared"); // below half: re-armed, and the agent is told
  assert.equal(spoke(901_000), "crossed");
  // The alarm switched off (or the window unknown) re-arms silently: switching it back on speaks again.
  assert.equal(spoke(950_000, resolveContextAlarm(0, fill(0, 1_000_000, 967_000))), undefined);
  assert.equal(spoke(950_000), "crossed");
});

test("the notice is the fixed line, numbers filled in, and names the way out", () => {
  const f = fill(903_112, 1_000_000, 967_000);
  const notice = formatContextAlarmNotice(f, resolveContextAlarm(undefined, f));
  assert.equal(
    notice,
    "⟦CONTEXT-ALARM⟧ Context 903,112 / 1,000,000 tokens (90.3 %) is past your 90 % alarm; " +
      "auto-compaction at ≈ 967,000. Finish this step, then hand over to a successor " +
      "(skill: context-succession). Off: acpx context --alarm 0",
  );
  const small = fill(150_000, 200_000, 167_000);
  assert.match(
    formatContextAlarmNotice(small, resolveContextAlarm(undefined, small)),
    /past your alarm \(90 %, moved to 147,000 to keep a 20,000-token runway before auto-compaction\)/,
  );
});

// ─── bbe2bc47 · the CLEARED notice: the alarm no longer applies ──────────────

const CLEARED_NOTICE_900K =
  "⟦CONTEXT-ALARM⟧ cleared — your context is now 120,000 / 1,000,000 tokens (12.0 %), far " +
  "below your alarm: it was auto-compacted (or your window grew). If you have not run " +
  '"acpx sessions handover" yet, do not hand over: continue your task in this session. ' +
  "If your successor already exists, finish the handover.";

test("the cleared notice is the fixed line, numbers filled in (the context-succession skill keys on it)", () => {
  assert.equal(
    formatContextAlarmClearedNotice(fill(120_000, 1_000_000, 967_000)),
    CLEARED_NOTICE_900K,
  );
  // Numbers come from the fill: Codex's window, a fill of 0 (Claude's compaction report).
  assert.match(
    formatContextAlarmClearedNotice(fill(37_839, 828_400, 784_800)),
    /^⟦CONTEXT-ALARM⟧ cleared — your context is now 37,839 \/ 828,400 tokens \(4\.6 %\), far below your alarm/,
  );
  assert.match(
    formatContextAlarmClearedNotice(fill(0, 1_000_000)),
    /now 0 \/ 1,000,000 tokens \(0\.0 %\)/,
  );
});

/** What a latch-like observer says over a fill sequence, as the events it raised. */
function eventsOver(
  latch: { observe(f: ContextFill, a: ReturnType<typeof resolveContextAlarm>): unknown },
  usedSequence: number[],
  window = 1_000_000,
  compactAt = 967_000,
): unknown[] {
  const alarm = resolveContextAlarm(undefined, fill(0, window, compactAt));
  return usedSequence.map((used) => latch.observe(fill(used, window, compactAt), alarm));
}

/** WRONG DOUBLE 1 — clears on ANY dip below the alarm after speaking (no half-point rule). */
class ClearsOnAnyDipLatch {
  private spoken = false;
  observe(
    f: ContextFill,
    a: ReturnType<typeof resolveContextAlarm>,
  ): ContextAlarmEvent | undefined {
    if (a.atTokens === undefined) {
      return undefined;
    }
    if (f.used < a.atTokens) {
      const was = this.spoken;
      this.spoken = false;
      return was ? "cleared" : undefined;
    }
    if (this.spoken) {
      return undefined;
    }
    this.spoken = true;
    return "crossed";
  }
}

/** WRONG DOUBLE 2 — never re-arms, and clears on every update below half. */
class ClearsEveryTimeLatch {
  private spoken = false;
  observe(
    f: ContextFill,
    a: ReturnType<typeof resolveContextAlarm>,
  ): ContextAlarmEvent | undefined {
    if (a.atTokens === undefined) {
      return undefined;
    }
    if (f.used < a.atTokens / 2) {
      return this.spoken ? "cleared" : undefined;
    }
    if (f.used >= a.atTokens && !this.spoken) {
      this.spoken = true;
      return "crossed";
    }
    return undefined;
  }
}

test("A1 — spoken, then the fill falls below half the alarm point: ONE cleared; a second compaction with no new crossing gives nothing", () => {
  const sequence = [850_000, 905_000, 950_000, 120_000, 100_000, 80_000, 60_000];
  const expected = [undefined, "crossed", undefined, "cleared", undefined, undefined, undefined];
  assert.deepEqual(eventsOver(new ContextAlarmLatch(), sequence), expected);
  // …and a NEW crossing arms it again: cleared once more after it.
  assert.deepEqual(eventsOver(new ContextAlarmLatch(), [905_000, 120_000, 910_000, 90_000]), [
    "crossed",
    "cleared",
    "crossed",
    "cleared",
  ]);
  // The row can fail: a latch that never re-arms raises "cleared" on every later report.
  assert.notDeepEqual(eventsOver(new ClearsEveryTimeLatch(), sequence), expected);
});

test("A2 (negative) — a dip just below the alarm is an estimate correcting itself: NO cleared notice", () => {
  // codex-acp's err-high charge crosses at 905,000, the next real report lands at 880,000.
  const sequence = [905_000, 880_000, 920_000, 450_001, 899_999];
  const expected = ["crossed", undefined, undefined, undefined, undefined];
  assert.deepEqual(eventsOver(new ContextAlarmLatch(), sequence), expected);
  // The row can fail: a latch that clears on any dip speaks on the very first correction.
  assert.deepEqual(eventsOver(new ClearsOnAnyDipLatch(), sequence), [
    "crossed",
    "cleared",
    "crossed",
    "cleared",
    undefined,
  ]);
  // The real Codex sequence of TE D2: two real crossings and the compaction between them
  // (37,152 → 16,106 at an alarm of 33,136) — cleared exactly once, on the compaction.
  const latch = new ContextAlarmLatch();
  const alarm = resolveContextAlarm(4, fill(0, 828_400, 40_000));
  const events = TE_CODEX_INTERLEAVING.map((used) =>
    latch.observe(fill(used, 828_400, 40_000), alarm),
  );
  assert.equal(
    events.filter((e) => e === "cleared").length,
    1,
    "one real compaction (half of 33,136 = 16,568)",
  );
  assert.equal(events[TE_CODEX_INTERLEAVING.indexOf(16_106)], "cleared");
  assert.equal(events[TE_CODEX_INTERLEAVING.indexOf(29_390)], undefined, "an err-high correction");
});

test("A3 — respawn: a detector built from a stored fill already past the alarm still clears on a later compaction", async () => {
  const stored = fill(905_000, 1_000_000, 967_000);
  const detector = new ContextAlarmDetector(async () => undefined, stored);
  // The new owner's FIRST report is the compaction: no crossing was ever observed here.
  assert.equal(await detector.observe(fill(120_000, 1_000_000, 967_000)), CLEARED_NOTICE_900K);
  assert.equal(await detector.observe(fill(100_000, 1_000_000, 967_000)), undefined, "once");
  // The row can fail: a detector with nothing stored (or a latch fed only the new reports)
  // never learns the alarm had spoken.
  const noStored = new ContextAlarmDetector(async () => undefined, undefined);
  assert.equal(await noStored.observe(fill(120_000, 1_000_000, 967_000)), undefined);
  assert.deepEqual(eventsOver(new ContextAlarmLatch(), [120_000]), [undefined]);
  // The stored fill is judged against the SEAT's level: a fill below an explicit 95 % alarm
  // was never past it, so there is nothing to clear.
  const high = new ContextAlarmDetector(async () => 95, stored);
  assert.equal(await high.observe(fill(120_000, 1_000_000, 967_000)), undefined);
});

test("A4 — no injector: the cleared notice is held and delivered EXACTLY ONCE at the top of the next turn", async () => {
  const detector = new ContextAlarmDetector(
    async () => undefined,
    fill(905_000, 1_000_000, 967_000),
  );
  const unregister = registerContextAlarmDetector("acp-session-a4", detector);
  try {
    const request = buildTurnContextRequest({
      sessionId: "acp-session-a4",
      agentCommand: "claude",
      sessionEnv: {},
    });
    const notice = await detector.observe(fill(120_000, 1_000_000, 967_000));
    assert.equal(notice, CLEARED_NOTICE_900K);
    // The runtime found no injector and hands the notice back to be held.
    detector.holdForTurnStart(notice ?? "");
    const first = await resolveTurnContext(request);
    assert.match(
      first ?? "",
      /<acpx-turn-context>[\s\S]*⟦CONTEXT-ALARM⟧ cleared — your context is now 120,000/,
    );
    assert.equal(await resolveTurnContext(request), undefined, "never repeated");
  } finally {
    unregister();
  }
  // The row can fail: a notice that was NOT held (the injector delivered it) is not repeated
  // at the next turn — and a detector never told to hold has nothing to deliver.
  const delivered = new ContextAlarmDetector(
    async () => undefined,
    fill(905_000, 1_000_000, 967_000),
  );
  await delivered.observe(fill(120_000, 1_000_000, 967_000));
  assert.equal(delivered.lineForTurnStart(), undefined);
  // A held cleared notice yields to a NEW crossing: the top of the turn is the alarm.
  const recrossed = new ContextAlarmDetector(
    async () => undefined,
    fill(905_000, 1_000_000, 967_000),
  );
  recrossed.holdForTurnStart((await recrossed.observe(fill(120_000, 1_000_000, 967_000))) ?? "");
  await recrossed.observe(fill(910_000, 1_000_000, 967_000));
  assert.match(
    recrossed.lineForTurnStart() ?? "",
    /^⟦CONTEXT-ALARM⟧ Context 910,000 .* is past your 90 % alarm/,
  );
});

test("A4 across tasks — a cleared notice no injector could take is carried to the top of the session's NEXT turn (a new task, a new detector), once", async () => {
  const session = "acp-session-a4-next-task";
  const clearedFill = fill(120_000, 1_000_000, 967_000);
  // Task 1: the alarm spoke earlier; the compaction report arrives with no injector.
  const task1 = new ContextAlarmDetector(async () => undefined, fill(905_000, 1_000_000, 967_000));
  const end1 = registerContextAlarmDetector(session, task1);
  const notice = await task1.observe(clearedFill);
  assert.equal(notice, CLEARED_NOTICE_900K);
  task1.holdForTurnStart(notice ?? "");
  end1();
  const request = buildTurnContextRequest({
    sessionId: session,
    agentCommand: "claude",
    sessionEnv: {},
  });
  // Task 2 starts from the stored (compacted) fill and is told once.
  const task2 = new ContextAlarmDetector(async () => undefined, clearedFill);
  const end2 = registerContextAlarmDetector(session, task2);
  try {
    assert.match(
      (await resolveTurnContext(request)) ?? "",
      /⟦CONTEXT-ALARM⟧ cleared — your context is now 120,000/,
    );
    assert.equal(await resolveTurnContext(request), undefined, "not repeated within the turn");
  } finally {
    end2();
  }
  // Task 3 hears nothing: the notice was delivered once.
  const task3 = new ContextAlarmDetector(async () => undefined, clearedFill);
  const end3 = registerContextAlarmDetector(session, task3);
  try {
    assert.equal(await resolveTurnContext(request), undefined, "once per compaction, not per turn");
  } finally {
    end3();
  }
  // A notice that went out through an injector is never held: nothing carries over.
  const other = "acp-session-a4-injected";
  const t1 = new ContextAlarmDetector(async () => undefined, fill(905_000, 1_000_000, 967_000));
  const e1 = registerContextAlarmDetector(other, t1);
  await t1.observe(clearedFill); // the runtime injected it: no holdForTurnStart call
  e1();
  const t2 = new ContextAlarmDetector(async () => undefined, clearedFill);
  const e2 = registerContextAlarmDetector(other, t2);
  try {
    assert.equal(
      await resolveTurnContext(
        buildTurnContextRequest({ sessionId: other, agentCommand: "claude", sessionEnv: {} }),
      ),
      undefined,
    );
  } finally {
    e2();
  }
});

test("A5 — harness-agnostic: Claude's compaction report (used: 0) after an alarm clears it", async () => {
  const detector = new ContextAlarmDetector(async () => undefined, undefined);
  assert.match(
    (await detector.observe(fill(905_000, 1_000_000, 967_000))) ?? "",
    /is past your 90 % alarm/,
  );
  assert.match(
    (await detector.observe(fill(0, 1_000_000, 967_000))) ?? "",
    /^⟦CONTEXT-ALARM⟧ cleared — your context is now 0 \/ 1,000,000 tokens \(0\.0 %\)/,
  );
  // Alarm off, or window unknown: re-armed silently, never a cleared notice.
  let level: number | undefined;
  const off = new ContextAlarmDetector(async () => level, undefined);
  await off.observe(fill(905_000, 1_000_000, 967_000));
  level = 0;
  assert.equal(await off.observe(fill(0, 1_000_000, 967_000)), undefined);
  const unknown = new ContextAlarmDetector(async () => undefined, undefined);
  await unknown.observe(fill(905_000, 1_000_000, 967_000));
  assert.equal(await unknown.observe(fill(10, 0)), undefined);
});

test("A6 — codex at its recomputed compaction point 559,594: the default alarm moves to 519,594; an explicit 90 % warns", () => {
  const f = fill(0, 828_400, 559_594);
  const dflt = resolveContextAlarm(undefined, f);
  assert.equal(dflt.atTokens, 519_594);
  assert.equal(dflt.movedForRunway, true);
  const explicit = resolveContextAlarm(90, f);
  assert.equal(explicit.pastCompaction, true);
  assert.equal(explicit.atTokens, 745_560);
});

test("A6 handover backstop — the stored fill below half the alarm point yields the note; at/above it, no fill, alarm off, or an impossible fill: silent", () => {
  const stored = (used: number, window = 828_400): SessionContextFill => ({
    used_tokens: used,
    window_tokens: window,
    compaction_tokens: 784_800,
  });
  // Default alarm 744,800 → half = 372,400.
  assert.match(
    handoverBelowAlarmNote(stored(97_088), undefined) ?? "",
    /^note: your context is 97,088 \/ 828,400 tokens, far below your alarm — it was probably compacted after the alarm, so this handover was not needed\. It has gone ahead: finish it with the close line above, and do not keep working in this session beside your successor\.$/,
  );
  assert.equal(handoverBelowAlarmNote(stored(372_400), undefined), undefined, "exactly half");
  assert.equal(handoverBelowAlarmNote(stored(700_000), undefined), undefined);
  assert.equal(handoverBelowAlarmNote(undefined, undefined), undefined);
  assert.equal(handoverBelowAlarmNote(stored(97_088), 0), undefined, "alarm off");
  assert.equal(handoverBelowAlarmNote(stored(0, 0), undefined), undefined, "window unknown");
  assert.equal(handoverBelowAlarmNote(stored(1_104_235), undefined), undefined, "impossible");
  // The seat's explicit level decides: 20 % of 828,400 = 165,680 → half 82,840.
  assert.equal(handoverBelowAlarmNote(stored(97_088), 20), undefined);
  assert.notEqual(handoverBelowAlarmNote(stored(80_000), 20), undefined);
});

// ─── the fill as reported, on the record ─────────────────────────────────────

function usageUpdate(used: number, size: number, atTokens?: number) {
  return {
    sessionId: "s",
    update: {
      sessionUpdate: "usage_update" as const,
      used,
      size,
      ...(atTokens === undefined ? {} : { _meta: { contextCompaction: { atTokens } } }),
    },
  };
}

test("the fill is remembered as REPORTED: size 0 stays 0, and a point the adapter stopped naming is not carried", () => {
  const conversation = createSessionConversation("2026-10-07T00:00:00.000Z");
  let acpx = recordSessionUpdate(conversation, undefined, usageUpdate(500_000, 1_000_000, 967_000));
  assert.deepEqual(acpx?.context_fill, {
    used_tokens: 500_000,
    window_tokens: 1_000_000,
    compaction_tokens: 967_000,
  });
  acpx = recordSessionUpdate(conversation, acpx, usageUpdate(600_000, 0));
  assert.deepEqual(acpx?.context_fill, { used_tokens: 600_000, window_tokens: 0 });
  // The remembered window for resume is untouched by the unknown report.
  assert.equal(acpx?.context_window_size, undefined);
});

test("brick 4a6716b5 — a report past a KNOWN window is not a fill: the previous reading stands; == window is one; unknown window unchanged", () => {
  const conversation = createSessionConversation("2026-10-09T00:00:00.000Z");
  // The very first report impossible ⇒ nothing stored.
  let acpx = recordSessionUpdate(conversation, undefined, usageUpdate(828_401, 828_400, 784_800));
  assert.equal(acpx?.context_fill, undefined);
  acpx = recordSessionUpdate(conversation, acpx, usageUpdate(217_168, 828_400, 784_800));
  // One token past the window, after a plausible reading ⇒ that reading stands.
  acpx = recordSessionUpdate(conversation, acpx, usageUpdate(828_401, 828_400, 784_800));
  assert.deepEqual(acpx?.context_fill, {
    used_tokens: 217_168,
    window_tokens: 828_400,
    compaction_tokens: 784_800,
  });
  // The boundary: exactly the window is a reading.
  acpx = recordSessionUpdate(conversation, acpx, usageUpdate(828_400, 828_400, 784_800));
  assert.equal(acpx?.context_fill?.used_tokens, 828_400);
  // Window unknown (0) ⇒ stored as reported, window 0.
  acpx = recordSessionUpdate(conversation, acpx, usageUpdate(5_000_000, 0));
  assert.deepEqual(acpx?.context_fill, { used_tokens: 5_000_000, window_tokens: 0 });
});

// ─── A · the level lives on the SEAT ─────────────────────────────────────────

const SEAT = "44444444-4444-4444-8444-444444444444";
const CHILD_SEAT = "55555555-5555-4555-8555-555555555555";

test("the seat row carries the level; `default` removes it from disk; a wrong value is a malformed row", async () => {
  await withTempHome("acpx-context-alarm-seat-", async () => {
    const dir = sessionBaseDir();
    await mintSeatRow(dir, {
      seatId: SEAT,
      holderId: "holder-1",
      name: undefined,
      createdAt: "2026-10-07T00:00:00.000Z",
      brickId: undefined,
    });
    assert.equal(seatFromStore(await readSeatStore(dir), SEAT)?.contextAlarm, undefined);
    assert.equal(await setSeatContextAlarm(dir, SEAT, 75), "set");
    assert.equal(await setSeatContextAlarm(dir, SEAT, 75), "unchanged");
    const raw = JSON.parse(await fs.readFile(path.join(dir, "seats.json"), "utf8"));
    assert.equal(raw[SEAT].context_alarm, 75);
    assert.equal(seatFromStore(await readSeatStore(dir), SEAT)?.contextAlarm, 75);
    assert.equal(await setSeatContextAlarm(dir, SEAT, undefined), "set");
    const after = JSON.parse(await fs.readFile(path.join(dir, "seats.json"), "utf8"));
    assert.equal("context_alarm" in after[SEAT], false);
  });
  for (const bad of [150, 90.5, "90", null]) {
    const store = parseSeatStore(
      JSON.stringify({
        [SEAT]: {
          seat_id: SEAT,
          created_at: "x",
          active_holder_id: null,
          next_ordinal: 2,
          closed_at: null,
          context_alarm: bad,
        },
      }),
      "/tmp/seats.json",
    );
    assert.deepEqual(store.malformedSeatIds, [SEAT], `context_alarm ${JSON.stringify(bad)}`);
  }
});

test("row 5 — the detector re-reads the seat every report: `--alarm 0` mid-turn silences the crossing", async () => {
  let level: number | undefined;
  const detector = new ContextAlarmDetector(async () => level, undefined);
  assert.equal(await detector.observe(fill(850_000, 1_000_000, 967_000)), undefined);
  level = 0;
  assert.equal(await detector.observe(fill(905_000, 1_000_000, 967_000)), undefined);
  assert.equal(detector.lineForTurnStart(), undefined);
  // Control: back on, the same fill speaks.
  level = undefined;
  assert.match(
    (await detector.observe(fill(906_000, 1_000_000, 967_000))) ?? "",
    /^⟦CONTEXT-ALARM⟧/,
  );
});

test("row 4 — the turn-context channel opens the next turn with the line, fresh numbers, inside the envelope", async () => {
  const detector = new ContextAlarmDetector(
    async () => undefined,
    fill(905_000, 1_000_000, 967_000),
  );
  const unregister = registerContextAlarmDetector("acp-session-row4", detector);
  try {
    const request = buildTurnContextRequest({
      sessionId: "acp-session-row4",
      agentCommand: "claude",
      sessionEnv: {},
    });
    const first = await resolveTurnContext(request);
    assert.match(
      first ?? "",
      /<acpx-turn-context>[\s\S]*⟦CONTEXT-ALARM⟧ Context 905,000 \/ 1,000,000/,
    );
    await detector.observe(fill(930_500, 1_000_000, 967_000));
    assert.match((await resolveTurnContext(request)) ?? "", /Context 930,500 \/ 1,000,000/);
    // Below the alarm (after a compaction): nothing.
    await detector.observe(fill(20_000, 1_000_000, 967_000));
    assert.equal(await resolveTurnContext(request), undefined);
  } finally {
    unregister();
  }
  // Another session's turn is never decorated with this one's alarm.
  assert.equal(
    await resolveTurnContext(
      buildTurnContextRequest({
        sessionId: "acp-session-row4",
        agentCommand: "claude",
        sessionEnv: {},
      }),
    ),
    undefined,
  );
});

// ─── C · mid-turn, through the real runtime ──────────────────────────────────

type SessionUpdateHandler = (notification: unknown) => void;

function promptText(input: PromptInput | string): string {
  return typeof input === "string"
    ? input
    : input.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** A usage report: `used` on the 1M window, or an explicit `[used, size]`. */
type RigUsage = number | readonly [used: number, size: number];

function alarmRig(params: { usages: RigUsage[]; seatLevel?: number; tailMs?: number }) {
  const injected: string[] = [];
  const turnTops: (string | undefined)[] = [];
  let onSessionUpdate: SessionUpdateHandler | undefined;
  let mainTurns = 0;
  const client = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: (handlers: { onSessionUpdate?: SessionUpdateHandler }) => {
      onSessionUpdate = handlers.onSessionUpdate;
    },
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: async (sessionId: string, input: PromptInput | string) => {
      const text = promptText(input);
      if (text.startsWith(CONTEXT_ALARM_MARKER)) {
        injected.push(text);
        return { stopReason: "end_turn" };
      }
      mainTurns += 1;
      // What the turn-context channel would put at the top of THIS turn.
      turnTops.push(
        await resolveTurnContext(
          buildTurnContextRequest({ sessionId, agentCommand: "claude", sessionEnv: {} }),
        ),
      );
      if (mainTurns === 1) {
        for (const usage of params.usages) {
          const [used, size] = typeof usage === "number" ? [usage, 1_000_000] : usage;
          onSessionUpdate?.(usageUpdate(used, size, 967_000));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // The injections of the last reports still need their seat-store read: let them land.
        await new Promise((resolve) => setTimeout(resolve, params.tailMs ?? 50));
      }
      return { stopReason: "end_turn" };
    },
  };
  return { client: client as unknown as AcpClient, injected, turnTops };
}

function task(requestId: string, text: string): QueueTask {
  return {
    requestId,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send: () => {},
    close: () => {},
  };
}

async function runTwoTurns(params: {
  usages: RigUsage[];
  seatLevel?: number;
  /** How long the first turn lingers after its last report (default 50 ms). */
  tailMs?: number;
  /** Also read back what the turns persisted: the record's fill and `acpx context`. */
  readBack?: boolean;
  /** A fill already on the record before the first turn (as an older build persisted it). */
  persistedFill?: SessionContextFill;
}) {
  return await withTempHome("acpx-context-alarm-runtime-", async (homeDir) => {
    const record: SessionRecord = {
      ...makeSessionRecord({
        acpxRecordId: "context-alarm-holder",
        acpSessionId: "context-alarm-acp-session",
        agentCommand: "claude",
        cwd: homeDir,
      }),
      seatId: SEAT,
      ...(params.persistedFill ? { acpx: { context_fill: params.persistedFill } } : {}),
    };
    await writeSessionRecordFile(homeDir, record);
    await mintSeatRow(sessionBaseDir(), {
      seatId: SEAT,
      holderId: record.acpxRecordId,
      name: undefined,
      createdAt: "2026-10-07T00:00:00.000Z",
      brickId: undefined,
    });
    if (params.seatLevel !== undefined) {
      await setSeatContextAlarm(sessionBaseDir(), SEAT, params.seatLevel);
    }
    const rig = alarmRig(params);
    let handler: ((task: QueueTask) => void) | undefined;
    const options = {
      sharedClient: rig.client,
      setMidTurnHandler: (next: ((task: QueueTask) => void) | undefined) => {
        handler = next;
      },
      suppressSdkConsoleErrors: true,
    };
    await runQueuedTask(record.acpxRecordId, task("turn-1", "work"), options);
    await runQueuedTask(record.acpxRecordId, task("turn-2", "a parent's message"), options);
    void handler;
    if (!params.readBack) {
      return { ...rig, storedFill: undefined, contextCli: undefined };
    }
    const stored = await resolveSessionRecord(record.acpxRecordId);
    const contextCli = await runCli(["context", "--session-id", record.acpxRecordId], homeDir);
    return { ...rig, storedFill: stored.acpx?.context_fill, contextCli };
  });
}

test("mid-turn: the crossing report injects ⟦CONTEXT-ALARM⟧ into the running turn — once — and the next turn opens with it", async () => {
  const rig = await runTwoTurns({ usages: [850_000, 905_000, 930_000, 950_000] });
  assert.equal(rig.injected.length, 1, `exactly one mid-turn notice, got ${rig.injected.length}`);
  assert.match(
    rig.injected[0] ?? "",
    /^⟦CONTEXT-ALARM⟧ Context 905,000 \/ 1,000,000 tokens \(90\.5 %\)/,
  );
  assert.equal(rig.turnTops[0], undefined, "turn 1 started below the alarm");
  assert.match(rig.turnTops[1] ?? "", /⟦CONTEXT-ALARM⟧ Context 950,000 \/ 1,000,000/);
});

test("bbe2bc47 — through the real runtime: the alarm, then a compaction, inject the cleared notice ONCE; a second compaction without a new crossing injects nothing", async () => {
  const rig = await runTwoTurns({
    usages: [850_000, 905_000, 950_000, 120_000, 100_000, 90_000, 80_000],
    tailMs: 500,
  });
  assert.equal(rig.injected.length, 2, `alarm + cleared, got ${JSON.stringify(rig.injected)}`);
  assert.match(rig.injected[0] ?? "", /^⟦CONTEXT-ALARM⟧ Context 905,000 \/ 1,000,000/);
  assert.equal(
    rig.injected[1],
    '⟦CONTEXT-ALARM⟧ cleared — your context is now 120,000 / 1,000,000 tokens (12.0 %), far below your alarm: it was auto-compacted (or your window grew). If you have not run "acpx sessions handover" yet, do not hand over: continue your task in this session. If your successor already exists, finish the handover.',
  );
  assert.deepEqual(rig.turnTops, [undefined, undefined], "nothing repeated at the next turn");
});

test("bbe2bc47 — through the real runtime (negative): a dip just below the alarm injects no cleared notice", async () => {
  const rig = await runTwoTurns({ usages: [905_000, 880_000, 920_000, 600_000], tailMs: 500 });
  assert.equal(rig.injected.length, 1, `only the alarm, got ${JSON.stringify(rig.injected)}`);
  assert.match(rig.injected[0] ?? "", /is past your 90 % alarm/);
});

test("bbe2bc47 — through the real runtime, respawn shape: a stored fill past the alarm, then a compaction in the next turn, clears", async () => {
  const rig = await runTwoTurns({
    usages: [50_000],
    tailMs: 500,
    persistedFill: { used_tokens: 905_000, window_tokens: 1_000_000, compaction_tokens: 967_000 },
  });
  assert.equal(rig.injected.length, 1);
  assert.match(
    rig.injected[0] ?? "",
    /^⟦CONTEXT-ALARM⟧ cleared — your context is now 50,000 \/ 1,000,000 tokens \(5\.0 %\)/,
  );
});

test("bbe2bc47 — through the real runtime, Claude shape: used 0 after the alarm clears", async () => {
  const rig = await runTwoTurns({ usages: [905_000, 0], tailMs: 500 });
  assert.equal(rig.injected.length, 2);
  assert.match(rig.injected[1] ?? "", /^⟦CONTEXT-ALARM⟧ cleared — your context is now 0 \//);
});

test("row 5 — the seat at 0: nothing mid-turn, nothing at the top of the next turn", async () => {
  const rig = await runTwoTurns({ usages: [850_000, 905_000, 950_000], seatLevel: 0 });
  assert.deepEqual(rig.injected, []);
  assert.deepEqual(rig.turnTops, [undefined, undefined]);
});

test("the seat's explicit level is what rings: 75 % crosses at 750,000", async () => {
  const rig = await runTwoTurns({ usages: [700_000, 760_000, 800_000], seatLevel: 75 });
  assert.equal(rig.injected.length, 1);
  assert.match(
    rig.injected[0] ?? "",
    /760,000 \/ 1,000,000 tokens \(76\.0 %\) is past your 75 % alarm/,
  );
});

// ─── brick 4a6716b5 · a report past a known window is not a fill (real turn) ─

test("4a6716b5 — window + 1 after a plausible reading: no notice, no turn-start line, the plausible fill stays on the record and in `acpx context`", async () => {
  const rig = await runTwoTurns({ usages: [850_000, 1_000_001], readBack: true });
  assert.deepEqual(rig.injected, []);
  assert.deepEqual(rig.turnTops, [undefined, undefined]);
  assert.deepEqual(rig.storedFill, {
    used_tokens: 850_000,
    window_tokens: 1_000_000,
    compaction_tokens: 967_000,
  });
  assert.equal(rig.contextCli?.code, 0, rig.contextCli?.stderr);
  assert.match(rig.contextCli?.stdout ?? "", /^context: 850,000 \/ 1,000,000 tokens \(85\.0 %\)/);
});

test("4a6716b5 — window + 1 as the very first report: nothing stored, no notice", async () => {
  const rig = await runTwoTurns({ usages: [1_000_001], readBack: true });
  assert.deepEqual(rig.injected, []);
  assert.deepEqual(rig.turnTops, [undefined, undefined]);
  assert.equal(rig.storedFill, undefined);
});

test("4a6716b5 — an impossible report after a real crossing: one notice, and the next turn opens with the REAL numbers", async () => {
  const rig = await runTwoTurns({ usages: [905_000, 1_200_000] });
  assert.equal(rig.injected.length, 1);
  assert.match(rig.injected[0] ?? "", /Context 905,000 \/ 1,000,000/);
  assert.match(rig.turnTops[1] ?? "", /⟦CONTEXT-ALARM⟧ Context 905,000 \/ 1,000,000/);
});

test("4a6716b5 — used == window is a reading: stored, and it rings past the level", async () => {
  const rig = await runTwoTurns({ usages: [1_000_000], readBack: true });
  assert.equal(rig.injected.length, 1);
  assert.match(
    rig.injected[0] ?? "",
    /^⟦CONTEXT-ALARM⟧ Context 1,000,000 \/ 1,000,000 tokens \(100\.0 %\)/,
  );
  assert.equal(rig.storedFill?.used_tokens, 1_000_000);
});

test("4a6716b5 — a record PERSISTED with an impossible fill (an older build): a real turn opens with no notice, and `acpx context` does not print it", async () => {
  const rig = await runTwoTurns({
    usages: [],
    persistedFill: { used_tokens: 1_104_235, window_tokens: 828_400, compaction_tokens: 784_800 },
    readBack: true,
  });
  assert.deepEqual(rig.injected, []);
  assert.deepEqual(rig.turnTops, [undefined, undefined]);
  assert.equal(rig.contextCli?.code, 0, rig.contextCli?.stderr);
  assert.doesNotMatch(rig.contextCli?.stdout ?? "", /1,104,235/);
  assert.match(rig.contextCli?.stdout ?? "", /^context: 0 \/ 0 tokens \(0\.0 %\)/);
});

test("4a6716b5 — window unknown (0), large used: stored as reported with window 0, no alarm (unchanged)", async () => {
  const rig = await runTwoTurns({ usages: [[5_000_000, 0]], readBack: true });
  assert.deepEqual(rig.injected, []);
  assert.deepEqual(rig.turnTops, [undefined, undefined]);
  assert.deepEqual(rig.storedFill, {
    used_tokens: 5_000_000,
    window_tokens: 0,
    compaction_tokens: 967_000,
  });
});

// ─── D · `acpx context`, through the compiled CLI ────────────────────────────

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
      "ACPX_UI_BASE_URL",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...env, ...extraEnv },
      cwd: homeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const PREDECESSOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUCCESSOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function seatRig(homeDir: string) {
  const holder = (
    id: string,
    seatId: string,
    ordinal: number,
    fillTokens: number,
  ): SessionRecord => ({
    ...makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: "claude",
      cwd: homeDir,
    }),
    seatId,
    holderOrdinal: ordinal,
    acpx: {
      context_fill: {
        used_tokens: fillTokens,
        window_tokens: 1_000_000,
        compaction_tokens: 967_000,
      },
    },
  });
  // Fixture-entered: the successor shares the seat BY CONSTRUCTION (same seatId) — the
  // handover verb that creates one is brick f74abb05's, after this build.
  await writeSessionRecordFile(homeDir, holder(PREDECESSOR, SEAT, 1, 910_000));
  await writeSessionRecordFile(homeDir, holder(SUCCESSOR, SEAT, 2, 30_000));
  await writeSessionRecordFile(homeDir, holder(CHILD, CHILD_SEAT, 1, 10_000));
  for (const [seatId, holderId] of [
    [SEAT, PREDECESSOR],
    [CHILD_SEAT, CHILD],
  ] as const) {
    await mintSeatRow(sessionBaseDir(), {
      seatId,
      holderId,
      name: undefined,
      createdAt: "2026-10-07T00:00:00.000Z",
      brickId: undefined,
    });
  }
}

test("row 6 — `acpx context --alarm` sets the SEAT: the successor shows it, the child shows the default", async () => {
  await withTempHome("acpx-context-cli-", async (homeDir) => {
    await seatRig(homeDir);
    const set = await runCli(["context", "--alarm", "75", "--session-id", PREDECESSOR], homeDir);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, new RegExp(`seat ${SEAT}: context alarm = 75 %`));

    const successor = await runCli(
      ["--format", "json", "context", "--session-id", SUCCESSOR],
      homeDir,
    );
    assert.equal(successor.code, 0, successor.stderr);
    const s = JSON.parse(successor.stdout);
    assert.deepEqual(
      {
        level: s.alarm.levelPct,
        isDefault: s.alarm.default,
        used: s.usedTokens,
        window: s.windowTokens,
      },
      { level: 75, isDefault: false, used: 30_000, window: 1_000_000 },
    );

    const child = JSON.parse(
      (await runCli(["--format", "json", "context", "--session-id", CHILD], homeDir)).stdout,
    );
    assert.deepEqual(
      { level: child.alarm.levelPct, isDefault: child.alarm.default },
      { level: 90, isDefault: true },
    );

    const restored = await runCli(
      ["context", "--alarm", "default", "--session-id", SUCCESSOR],
      homeDir,
    );
    assert.match(restored.stdout, /context alarm = default/);
    assert.match(restored.stdout, /alarm 90 % \(default\) at 900,000/);
  });
});

test("`acpx context` with no address reads the caller's own session from $ACPX_SESSION_URL", async () => {
  await withTempHome("acpx-context-cli-own-", async (homeDir) => {
    await seatRig(homeDir);
    const own = await runCli(["context"], homeDir, {
      ACPX_SESSION_URL: `https://atrium.example/?session=${PREDECESSOR}`,
    });
    assert.equal(own.code, 0, own.stderr);
    assert.equal(
      own.stdout,
      "context: 910,000 / 1,000,000 tokens (91.0 %) · alarm 90 % (default) at 900,000 · auto-compaction at 967,000\n",
    );
    // Control: no address and no env ⇒ refused, never a guess.
    const none = await runCli(["context"], homeDir);
    assert.notEqual(none.code, 0);
    assert.match(none.stdout + none.stderr, /no session given/);
  });
});

test("an explicit level past compaction is honoured with a one-line warning", async () => {
  await withTempHome("acpx-context-cli-warn-", async (homeDir) => {
    await seatRig(homeDir);
    const res = await runCli(["context", "--alarm", "99", "--session-id", PREDECESSOR], homeDir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /alarm 99 % at 990,000/);
    assert.match(res.stdout, /⚠ alarm 99 % sits at or past this session's auto-compaction point/);
  });
});

test("`acpx status` carries one context line", async () => {
  await withTempHome("acpx-context-cli-status-", async (homeDir) => {
    await seatRig(homeDir);
    const res = await runCli(["status", "--session-id", PREDECESSOR], homeDir);
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.split("\n").filter((line) => line.startsWith("context: "));
    assert.deepEqual(lines, [
      "context: 910,000 / 1,000,000 tokens (91.0 %) · alarm 90 % (default) at 900,000 · auto-compaction at 967,000",
    ]);
  });
});
