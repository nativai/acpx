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
  registerContextAlarmDetector,
} from "../src/session/context-alarm-detector.js";
import {
  CONTEXT_ALARM_MARKER,
  ContextAlarmLatch,
  type ContextFill,
  contextUsedPct,
  formatContextAlarmNotice,
  formatContextLine,
  parseContextAlarmArgument,
  resolveContextAlarm,
} from "../src/session/context-alarm.js";
import { recordSessionUpdate } from "../src/session/conversation-model.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import { sessionBaseDir } from "../src/session/persistence/repository.js";
import {
  mintSeatRow,
  parseSeatStore,
  readSeatStore,
  seatFromStore,
  setSeatContextAlarm,
} from "../src/session/persistence/seat-store.js";
import type { SessionRecord } from "../src/types.js";
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
  assert.equal(new ContextAlarmLatch().observe(fill(999_999, 1_000_000, 967_000), alarm), false);
});

test("row 8 — unknown window (0): usage 0 %, no alarm, and no 'unconfirmed' wording", () => {
  const unknown = fill(180_089, 0);
  const alarm = resolveContextAlarm(undefined, unknown);
  assert.equal(alarm.atTokens, undefined);
  assert.equal(contextUsedPct(unknown), 0);
  assert.equal(new ContextAlarmLatch().observe(unknown, alarm), false);
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
  assert.deepEqual(spoke, [false, true, false, false, false, false, true]);
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
  const spokeAt = TE_CODEX_INTERLEAVING.filter((used) =>
    latch.observe(fill(used, 828_400, 40_000), alarm),
  );
  assert.deepEqual(spokeAt, [53_467, 47_647]);
});

test("D2 — re-arm rule: only a drop below HALF the alarm point (a compaction, /compact) re-arms; off/unknown re-arms too", () => {
  const alarm = resolveContextAlarm(undefined, fill(0, 1_000_000, 967_000)); // 900,000
  const latch = new ContextAlarmLatch();
  const spoke = (used: number, a = alarm) => latch.observe(fill(used, 1_000_000, 967_000), a);
  assert.equal(spoke(905_000), true);
  assert.equal(spoke(880_000), false); // an estimate corrected down: NOT re-armed
  assert.equal(spoke(920_000), false);
  assert.equal(spoke(450_001), false); // still above half
  assert.equal(spoke(910_000), false);
  assert.equal(spoke(449_999), false); // below half: re-armed
  assert.equal(spoke(901_000), true);
  // The alarm switched off (or the window unknown) re-arms: switching it back on speaks again.
  assert.equal(spoke(950_000, resolveContextAlarm(0, fill(0, 1_000_000, 967_000))), false);
  assert.equal(spoke(950_000), true);
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

function alarmRig(params: { usages: number[]; seatLevel?: number }) {
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
        for (const used of params.usages) {
          onSessionUpdate?.(usageUpdate(used, 1_000_000, 967_000));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
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

async function runTwoTurns(params: { usages: number[]; seatLevel?: number }) {
  return await withTempHome("acpx-context-alarm-runtime-", async (homeDir) => {
    const record: SessionRecord = {
      ...makeSessionRecord({
        acpxRecordId: "context-alarm-holder",
        acpSessionId: "context-alarm-acp-session",
        agentCommand: "claude",
        cwd: homeDir,
      }),
      seatId: SEAT,
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
    return rig;
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
