import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ownerExitReapGateReason,
  ownerExitReapsTranscripts,
  reapTranscriptsAtOwnerExit,
  settleOwnerProcessGroup,
  type GroupSettleResult,
} from "../src/cli/session/owner-exit-transcript-reap.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import type { SubscriptionRegistry } from "../src/config/subscriptions.js";
import { readExitTailFile } from "../src/config/transcript-dedup.js";
import {
  formatTranscriptReapLines,
  reapLeftBehindTranscripts,
} from "../src/config/transcript-reap.js";
import type { SessionRecord } from "../src/types.js";
import { withTempHome } from "./temp-home.js";
import {
  ageFile,
  conversation,
  exists,
  exitLine,
  jsonl,
  SESSION_A,
  sha256File,
  writeFileAt,
} from "./transcript-fixture-test-helpers.js";

// Matrix C of brick 81433524's TEST-PLAN: D2, the queue owner's exit reap. The
// left-behind copy sits in subA; the record is bound to subB, whose copy is active.

const CWD = "/work/reap";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const ELEVEN_MIN = 11 * 60_000;

type Fixture = {
  home: string;
  registry: SubscriptionRegistry;
  subA: string;
  subB: string;
  subC: string;
  sub4: string;
  active: string;
  leftBehind: string;
};

async function withFixture(run: (fx: Fixture) => Promise<void>): Promise<void> {
  await withTempHome("acpx-reap-", async (home) => {
    const dir = (id: string) => path.join(home, ".acpx", "subscriptions", id);
    const [subA, subB, subC, sub4] = ["subA", "subB", "subC", "sub4"].map(dir);
    for (const configDir of [subA, subB, subC, sub4]) {
      await fs.mkdir(configDir, { recursive: true });
    }
    const entry = (id: string, configDir: string) => ({ id, label: id, configDir, account: id });
    const registry: SubscriptionRegistry = {
      default: "subA",
      // sub4 is on disk but NOT in the registry (DIVERGENCE §4).
      subscriptions: [entry("subA", subA), entry("subB", subB), entry("subC", subC)],
    };
    await run({
      home,
      registry,
      subA,
      subB,
      subC,
      sub4,
      active: transcriptJsonlPath(subB, CWD, SESSION_A),
      leftBehind: transcriptJsonlPath(subA, CWD, SESSION_A),
    });
  });
}

function record(profile: string | null = "subB") {
  return {
    cwd: CWD,
    acpSessionId: SESSION_A,
    agentCommand: CLAUDE_COMMAND,
    acpx: profile ? { session_options: { profile } } : {},
  } as unknown as SessionRecord;
}

function shapes() {
  const p = conversation(SESSION_A, { pairs: 16 });
  const newer = conversation(SESSION_A, {
    pairs: 3,
    seed: "newer",
    startMinute: 200,
    parent: p.lastUuid,
  });
  return { p, pText: jsonl(p.lines), newerText: jsonl(newer.lines) };
}

async function reap(
  fx: Fixture,
  extra: Partial<Parameters<typeof reapLeftBehindTranscripts>[0]> = {},
) {
  return await reapLeftBehindTranscripts({
    record: record(),
    lookup: { homeDir: fx.home, registry: fx.registry },
    ...extra,
  });
}

test("C1: a byte-prefix left-behind copy is deleted at the idle exit", async () => {
  await withFixture(async (fx) => {
    const { pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    await writeFileAt(fx.leftBehind, pText);
    await ageFile(fx.leftBehind, ELEVEN_MIN);
    const summary = await reap(fx);
    assert.equal(await exists(fx.leftBehind), false);
    assert.equal(await fs.readFile(fx.active, "utf8"), pText + newerText);
    const lines = formatTranscriptReapLines(summary).join("");
    assert.match(lines, /transcript-reap session=\S+ active=\S+ deleted=1 reduced=0 /);
    assert.match(lines, /transcript-reap-file action=deleted /);
  });
});

test("C2 (T): an exit-tail left-behind copy is reduced and restorable", async () => {
  await withFixture(async (fx) => {
    const { p, pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    const body =
      pText +
      jsonl([
        exitLine("cost-state", SESSION_A, p.lastUuid),
        exitLine("last-prompt", SESSION_A, p.lastUuid),
      ]);
    await writeFileAt(fx.leftBehind, body);
    await ageFile(fx.leftBehind, ELEVEN_MIN);
    const before = await sha256File(fx.leftBehind);
    const summary = await reap(fx);
    assert.equal(await exists(fx.leftBehind), false);
    const reduced = summary.files.find((file) => file.action === "reduced");
    assert.ok(reduced?.tailFile);
    const { header, tail } = await readExitTailFile(reduced.tailFile);
    assert.equal(header.reduced_by, "owner-exit");
    const active = await fs.readFile(fx.active);
    const rebuilt = Buffer.concat([active.subarray(0, header.prefix_bytes), tail]);
    assert.equal(rebuilt.toString(), body);
    assert.equal(header.original_sha256, before);
  });
});

test("C3 / negative 3: a divergent left-behind copy survives at its canonical path, byte-identical", async () => {
  await withFixture(async (fx) => {
    const { p, pText, newerText } = shapes();
    const branch = conversation(SESSION_A, {
      pairs: 2,
      seed: "branch",
      startMinute: 90,
      parent: p.lastUuid,
    });
    await writeFileAt(fx.active, pText + newerText);
    await writeFileAt(fx.leftBehind, pText + jsonl(branch.lines));
    await ageFile(fx.leftBehind, ELEVEN_MIN);
    const before = await sha256File(fx.leftBehind);
    const summary = await reap(fx);
    assert.equal(await sha256File(fx.leftBehind), before);
    assert.match(formatTranscriptReapLines(summary).join(""), /kept=1 keptReasons=divergent-/);
  });
});

test("C4 / negative 4: a left-behind copy = active + ONE unique trailing byte survives", async () => {
  await withFixture(async (fx) => {
    const { pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    await writeFileAt(fx.leftBehind, `${pText + newerText}x`);
    await ageFile(fx.leftBehind, ELEVEN_MIN);
    const before = await sha256File(fx.leftBehind);
    const summary = await reap(fx);
    assert.equal(await sha256File(fx.leftBehind), before);
    assert.equal(summary.files.length, 0);
  });
});

test("C9 / negative 8: an active copy that is not the freshest — nothing is removed", async () => {
  await withFixture(async (fx) => {
    // S9: the record's active copy is the e-meta one; the other copy is newer.
    const { p, pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + jsonl([exitLine("last-prompt", SESSION_A, p.lastUuid)]));
    await writeFileAt(fx.leftBehind, pText + newerText);
    await ageFile(fx.leftBehind, ELEVEN_MIN);
    await ageFile(fx.active, ELEVEN_MIN);
    const activeBefore = await sha256File(fx.active);
    const otherBefore = await sha256File(fx.leftBehind);
    const summary = await reap(fx);
    assert.deepEqual(summary.skipped, ["not-freshest"]);
    assert.equal(await sha256File(fx.active), activeBefore);
    assert.equal(await sha256File(fx.leftBehind), otherBefore);
  });
});

test("C10: a left-behind copy written 2 minutes ago is untouched (quiet guard)", async () => {
  await withFixture(async (fx) => {
    const { pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    await writeFileAt(fx.leftBehind, pText);
    await ageFile(fx.leftBehind, 2 * 60_000);
    const summary = await reap(fx);
    assert.equal(await exists(fx.leftBehind), true);
    assert.deepEqual(summary.keptReasons, { recent: 1 });
  });
});

test("C13: a copy in an UNREGISTERED dir (sub4) is not the owner exit's business", async () => {
  await withFixture(async (fx) => {
    const { pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    const stray = await writeFileAt(transcriptJsonlPath(fx.sub4, CWD, SESSION_A), pText);
    await ageFile(stray, ELEVEN_MIN);
    const summary = await reap(fx);
    assert.equal(await exists(stray), true);
    assert.deepEqual(formatTranscriptReapLines(summary), [], "no candidates, no line");
  });
});

test("C15: the per-exit budget stops the reap and leaves the rest whole", async () => {
  await withFixture(async (fx) => {
    const { pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    await writeFileAt(fx.leftBehind, pText);
    const third = await writeFileAt(transcriptJsonlPath(fx.subC, CWD, SESSION_A), pText);
    await ageFile(fx.leftBehind, ELEVEN_MIN);
    await ageFile(third, ELEVEN_MIN);
    const summary = await reap(fx, {
      budget: { wallMs: 60_000, bytes: Buffer.byteLength(pText) + 10 },
    });
    assert.equal(summary.files.length, 1, "exactly one copy fits the byte budget");
    assert.deepEqual(summary.skipped, ["budget"]);
    const remaining = [await exists(fx.leftBehind), await exists(third)].filter(Boolean);
    assert.equal(remaining.length, 1);
    assert.match(formatTranscriptReapLines(summary).join(""), /skipped=budget/);
  });
});

test("which exits reap: only an idle release", () => {
  assert.equal(ownerExitReapsTranscripts("idle-release"), true);
  assert.equal(ownerExitReapsTranscripts("turn-boundary-recycle"), false);
  assert.equal(ownerExitReapsTranscripts("other"), false);
});

test("C11 / C12: unbound and non-Claude records are gated out", () => {
  assert.equal(ownerExitReapGateReason(record()), undefined);
  assert.equal(ownerExitReapGateReason(record(null)), "unbound");
  const codex = {
    ...record(),
    agentCommand: "npx @agentclientprotocol/codex-acp",
  } as SessionRecord;
  assert.equal(ownerExitReapGateReason(codex), "not-claude");
  const noId = { ...record(), acpSessionId: " " } as SessionRecord;
  assert.equal(ownerExitReapGateReason(noId), "no-session-id");
});

function exitReapSpy(rec: SessionRecord, settled: GroupSettleResult) {
  const calls: string[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    deps: {
      resolveRecord: async () => {
        calls.push("resolve");
        return rec;
      },
      settle: async () => {
        calls.push("settle");
        return settled;
      },
      reap: async () => {
        calls.push("reap");
        return { session: SESSION_A, active: "/a", files: [], keptReasons: {}, skipped: [] };
      },
      write: (line: string) => lines.push(line),
    },
  };
}

test("C5: a turn-boundary recycle takes no group step and no reap", async () => {
  const spy = exitReapSpy(record(), { settled: true, killed: 0 });
  await reapTranscriptsAtOwnerExit({
    sessionId: "s",
    exitKind: "turn-boundary-recycle",
    isGroupLeader: () => true,
    superseded: false,
    deps: spy.deps,
  });
  assert.deepEqual(spy.calls, []);
});

test("C7 / negative 7: a group member that cannot be confirmed dead skips the reap (group-busy)", async () => {
  const spy = exitReapSpy(record(), { settled: false, survivors: [4242] });
  await reapTranscriptsAtOwnerExit({
    sessionId: "s",
    exitKind: "idle-release",
    isGroupLeader: () => true,
    superseded: false,
    deps: spy.deps,
  });
  assert.deepEqual(spy.calls, ["resolve", "settle"]);
  assert.match(spy.lines.join(""), /skipped=group-busy survivors=4242/);
});

test("C8 / C12: no leader → no reap; non-Claude → not even the group step", async () => {
  const notLeader = exitReapSpy(record(), { settled: true, killed: 0 });
  await reapTranscriptsAtOwnerExit({
    sessionId: "s",
    exitKind: "idle-release",
    isGroupLeader: () => false,
    superseded: false,
    deps: notLeader.deps,
  });
  assert.deepEqual(notLeader.calls, ["resolve"]);
  assert.match(notLeader.lines.join(""), /skipped=no-leader/);

  const codex = {
    ...record(),
    agentCommand: "npx @agentclientprotocol/codex-acp",
  } as SessionRecord;
  const nonClaude = exitReapSpy(codex, { settled: true, killed: 0 });
  await reapTranscriptsAtOwnerExit({
    sessionId: "s",
    exitKind: "idle-release",
    isGroupLeader: () => true,
    superseded: false,
    deps: nonClaude.deps,
  });
  assert.deepEqual(nonClaude.calls, ["resolve"]);
  assert.deepEqual(nonClaude.lines, []);
});

test("an idle exit with an empty group reaps; a superseded owner never does", async () => {
  const idle = exitReapSpy(record(), { settled: true, killed: 0 });
  await reapTranscriptsAtOwnerExit({
    sessionId: "s",
    exitKind: "idle-release",
    isGroupLeader: () => true,
    superseded: false,
    deps: idle.deps,
  });
  assert.deepEqual(idle.calls, ["resolve", "settle", "resolve", "reap"]);
  const superseded = exitReapSpy(record(), { settled: true, killed: 0 });
  await reapTranscriptsAtOwnerExit({
    sessionId: "s",
    exitKind: "idle-release",
    isGroupLeader: () => true,
    superseded: true,
    deps: superseded.deps,
  });
  assert.deepEqual(superseded.calls, []);
});

test("C7: settleOwnerProcessGroup reports a survivor it could not kill", async () => {
  let clock = 0;
  const killed: number[] = [];
  const result = await settleOwnerProcessGroup({
    pgid: 100,
    selfPid: 100,
    graceMs: 200,
    confirmMs: 100,
    deps: {
      listMembers: () => [4242],
      readPgrp: () => 100,
      kill: (pid) => killed.push(pid),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
  });
  assert.deepEqual(result, { settled: false, survivors: [4242] });
  assert.deepEqual(killed, [4242]);
});

test("settleOwnerProcessGroup never kills a pid whose pgrp changed (reused pid)", async () => {
  let clock = 0;
  const killed: number[] = [];
  const result = await settleOwnerProcessGroup({
    pgid: 100,
    selfPid: 100,
    graceMs: 100,
    deps: {
      listMembers: () => (killed.length === 0 && clock < 100 ? [4242] : []),
      readPgrp: () => 999,
      kill: (pid) => killed.push(pid),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
  });
  assert.deepEqual(killed, []);
  assert.equal(result.settled, true);
});

/**
 * A REAL process group: a detached leader (standing in for the owner) whose child
 * ignores SIGTERM and appends to `file` by PATH every 100 ms — Claude Code's own
 * write pattern (open → append → close, creating a missing file).
 */
async function startAppendingGroup(file: string) {
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", \`
      process.on("SIGTERM", () => {});
      const fs = require("node:fs");
      setInterval(() => fs.appendFileSync(process.argv[1], '{"type":"cost-state","sessionId":"x"}\\\\n'), 100);
      process.stdout.write("appending");
    \`, process.argv[1]], { stdio: ["ignore", "inherit", "inherit"] });
    setInterval(() => {}, 1000);
  `;
  const leader = spawn(process.execPath, ["-e", script, file], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => leader.stdout?.once("data", () => resolve()));
  return leader;
}

test("C6: the group step kills a lingering writer before the reap — no fragment appears afterwards", async () => {
  await withFixture(async (fx) => {
    const { pText, newerText } = shapes();
    await writeFileAt(fx.active, pText + newerText);
    await writeFileAt(fx.leftBehind, pText);
    const leader = await startAppendingGroup(fx.leftBehind);
    const pgid = leader.pid ?? 0;
    try {
      const settled = await settleOwnerProcessGroup({ pgid, selfPid: pgid, graceMs: 300 });
      assert.equal(settled.settled, true, JSON.stringify(settled));
      await ageFile(fx.leftBehind, ELEVEN_MIN);
      const summary = await reap(fx);
      // The writer's lines made the copy P + an exit block, so once the writer is dead it
      // is reduced. Without the group step the writer would still be appending: the
      // proof either refuses (changed-during-verify → no reduction) or the next append
      // recreates the path as a fragment. Both fail below.
      assert.equal(summary.files.length, 1, JSON.stringify(summary));
      assert.equal(summary.files[0]?.action, "reduced");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(await exists(fx.leftBehind), false, "no fragment recreated at the path");
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // group already gone
      }
    }
  });
});
