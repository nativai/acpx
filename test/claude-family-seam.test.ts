import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isClaudeFamilyAgent } from "../src/acp/agent-command.js";
import { HARNESS_IDS } from "../src/acp/harness-capabilities.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { switchSessionAccount } from "../src/runtime/engine/account-seam.js";
import {
  formatAccountSeamRepairResult,
  repairAccountSeamRecords,
} from "../src/session/account-seam-repair.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// B0.2 — the Claude-family gate on the account/subscription seam (CONCEPTION §5.5,
// brick https://acpx.devbox.nativai.de/?brick=07bc257a). One predicate at both
// ends; a sweep for the records the seam already wedged.

const CLAUDE = "node /opt/claude-agent-acp/dist/index.js";
const CLAUDE_PTY = "node /opt/claude-pty-acp/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";
const OPENCODE = AGENT_REGISTRY.opencode;
const PI = AGENT_REGISTRY.pi;

function recordFor(
  id: string,
  agentCommand: string,
  sessionOptions?: Record<string, unknown>,
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand,
    cwd: "/workspace/projects/temp",
    ...(sessionOptions ? { acpx: { session_options: sessionOptions } } : {}),
  });
}

// ── The predicate ────────────────────────────────────────────────────────────

test("isClaudeFamilyAgent classifies EVERY harness this fleet launches, from the registry's own strings", () => {
  // The commands come from AGENT_REGISTRY rather than being retyped here, so a
  // registry change that moves a harness's command cannot leave this test
  // asserting about a spelling nothing launches any more.
  assert.equal(isClaudeFamilyAgent(AGENT_REGISTRY.claude), true);
  assert.equal(isClaudeFamilyAgent(AGENT_REGISTRY["claude-pty"]), true);
  assert.equal(isClaudeFamilyAgent(AGENT_REGISTRY.codex), false);
  assert.equal(isClaudeFamilyAgent(AGENT_REGISTRY.opencode), false);
  assert.equal(isClaudeFamilyAgent(AGENT_REGISTRY.pi), false);

  // And the descriptor's five harness ids are exactly the five the seam has to
  // answer for — if a sixth is declared, this test names it rather than letting
  // it fall silently into whichever branch the predicate happens to take.
  assert.deepEqual([...HARNESS_IDS], ["claude", "claude-pty", "codex", "opencode", "pi"]);
});

test("isClaudeFamilyAgent recognises a dev-override claude command, not just the /opt one", () => {
  // ACPX_CLAUDE_ACP_COMMAND / a config `agents` entry pointing at a checkout. All
  // three of these spellings exist in the real store on devbox (measured
  // 2026-09-04): a worktree build is still the claude adapter.
  assert.equal(
    isClaudeFamilyAgent('node "/workspace/projects/claude-agent-acp/forkfund-fw12/dist/index.js"'),
    true,
  );
  assert.equal(
    isClaudeFamilyAgent("node /workspace/projects/claude-pty-acp/main/dist/index.js"),
    true,
  );
});

test("an unrecognised or absent agent command is NOT Claude family — the fail-safe direction", () => {
  // ⚠️ This is the direction that matters and it is asserted deliberately.
  // Classifying an unknown adapter INTO the family is what writes a Claude
  // account switch onto a record that can never hold a Claude transcript, after
  // which every later turn dies demanding it. Classifying it OUT costs at most
  // auto-failover, visibly.
  assert.equal(isClaudeFamilyAgent(undefined), false);
  assert.equal(isClaudeFamilyAgent(""), false);
  assert.equal(isClaudeFamilyAgent("   "), false);
  assert.equal(isClaudeFamilyAgent("some-unknown-adapter --acp"), false);
  // A bare `claude` token is NOT the claude ADAPTER: `isClaudeAcpCommand` matches
  // on `claude-agent-acp`, and no record in the real store carries a bare token
  // (measured 2026-09-04 across 2,924 records on devbox — every claude record is
  // a `.../claude-agent-acp/.../index.js` path).
  assert.equal(isClaudeFamilyAgent("claude"), false);
});

// ── The writer end ───────────────────────────────────────────────────────────

test("switchSessionAccount REFUSES on a non-Claude record — before any transcript work", async () => {
  for (const agentCommand of [CODEX, OPENCODE, PI]) {
    const record = recordFor("rec-writer", agentCommand);
    await assert.rejects(
      () => switchSessionAccount(record, "subB", "failover"),
      (error: Error) => {
        assert.equal(error.name, "AccountSwitchError");
        assert.match(error.message, /not a Claude-family adapter/);
        return true;
      },
      `expected a loud refusal for ${agentCommand}`,
    );
    // The refusal must leave the record untouched: a partial write here is the
    // corruption the gate exists to prevent.
    assert.equal(record.acpx?.session_options?.profile, undefined);
    assert.equal(record.acpx?.session_options?.account_switch, undefined);
  }
});

// ── The sweep ────────────────────────────────────────────────────────────────

type SweepFixture = {
  storeDir: string;
  records: SessionRecord[];
  saved: string[];
};

async function withSweepFixture(run: (fixture: SweepFixture) => Promise<void>): Promise<void> {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-seam-sweep-"));
  try {
    await run({ storeDir, records: [], saved: [] });
  } finally {
    await fs.rm(storeDir, { recursive: true, force: true });
  }
}

const WEDGED_OPTIONS = {
  profile: "sub7",
  account_switch: {
    fromProfile: "sub5",
    toProfile: "sub7",
    fromAccount: "acct-5",
    toAccount: "acct-7",
    reason: "selection",
    at: "2026-09-03T00:00:00.000Z",
  },
  subscription: "sub5",
};

async function seedRecordFile(storeDir: string, record: SessionRecord): Promise<string> {
  const file = path.join(storeDir, `${encodeURIComponent(record.acpxRecordId)}.json`);
  await fs.writeFile(file, JSON.stringify({ acpx_record_id: record.acpxRecordId }, null, 2));
  return file;
}

test("the sweep clears profile/account_switch/subscription from non-Claude records, backs each up, and is idempotent", async () => {
  await withSweepFixture(async (fixture) => {
    const wedgedCodex = recordFor("rec-codex", CODEX, { ...WEDGED_OPTIONS });
    // The opencode record carries the live `set auto-failover off` workaround — the
    // exact shape the carve-out must preserve.
    const wedgedOpencode = recordFor("rec-oc", OPENCODE, {
      ...WEDGED_OPTIONS,
      auto_failover: false,
    });
    const healthyClaude = recordFor("rec-claude", CLAUDE, { ...WEDGED_OPTIONS });
    const cleanPi = recordFor("rec-pi", PI, { auto_failover: false });
    const subagent = recordFor("rec-subagent", "", { ...WEDGED_OPTIONS });
    subagent.agentCommand = "";
    const records = [wedgedCodex, wedgedOpencode, healthyClaude, cleanPi, subagent];
    for (const record of records) {
      await seedRecordFile(fixture.storeDir, record);
    }

    const saved: string[] = [];
    const backupDir = path.join(fixture.storeDir, "backups");
    const options = {
      backupDir,
      loadRecords: async () => records,
      saveRecord: async (record: SessionRecord) => {
        saved.push(record.acpxRecordId);
      },
      storeDir: () => fixture.storeDir,
      isRecordBusy: async () => false,
    };

    // (a) DRY RUN first: it must find the population and change nothing.
    const preview = await repairAccountSeamRecords({ ...options, dryRun: true });
    assert.equal(preview.repaired.length, 2);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.repaired.map((entry) => entry.acpxRecordId).toSorted(), [
      "rec-codex",
      "rec-oc",
    ]);
    assert.equal(saved.length, 0, "a dry run must not write");
    assert.equal(wedgedCodex.acpx?.session_options?.profile, "sub7", "a dry run must not mutate");

    // (b) THE REAL RUN.
    const result = await repairAccountSeamRecords(options);
    assert.equal(result.failures.length, 0);
    assert.equal(result.repaired.length, 2);
    assert.equal(result.skippedClaudeFamily, 1, "the claude record is skipped by construction");
    assert.equal(result.skippedUnknownAgent, 1, "a subagent (no agent command) is NOT swept");
    assert.equal(result.alreadyClean, 1, "the pi record carried no cleared field");
    assert.equal(result.skippedBusy.length, 0);
    assert.deepEqual(saved.toSorted(), ["rec-codex", "rec-oc"]);

    // The three Claude-family fields are gone.
    assert.equal(wedgedCodex.acpx?.session_options?.profile, undefined);
    assert.equal(wedgedCodex.acpx?.session_options?.account_switch, undefined);
    assert.equal(wedgedCodex.acpx?.session_options?.subscription, undefined);
    assert.deepEqual(result.repaired[0]?.cleared.toSorted(), [
      "account_switch",
      "profile",
      "subscription",
    ]);
    // ⚠️ THE CARVE-OUT, pinned rather than trusted: `auto_failover` is
    // Claude-family by CONCEPTION 5.5 and is DELIBERATELY RETAINED. It carries the
    // fleet's `set auto-failover off` workaround, which is the only thing keeping
    // opencode and pi sessions alive until this gate deploys — clearing it would
    // re-wedge exactly the sessions the sweep exists to free (WS-core, 2026-09-04).
    assert.equal(
      wedgedOpencode.acpx?.session_options?.auto_failover,
      false,
      "auto_failover must survive the sweep",
    );
    assert.equal(
      result.repaired.some((entry) => entry.retainedAutoFailover),
      true,
    );
    // The Claude record keeps everything — the sweep never touches the family.
    assert.equal(healthyClaude.acpx?.session_options?.profile, "sub7");
    assert.notEqual(healthyClaude.acpx?.session_options?.account_switch, undefined);
    // The subagent is untouched too.
    assert.equal(subagent.acpx?.session_options?.profile, "sub7");

    // (c) THE BACKUP EXISTS AND HAS CONTENT — this is the whole safety claim.
    const backups = (await fs.readdir(backupDir)).toSorted();
    assert.deepEqual(backups, ["rec-codex.json", "rec-oc.json"]);
    for (const name of backups) {
      const payload = await fs.readFile(path.join(backupDir, name), "utf8");
      assert.ok(payload.trim().length > 0, `${name} backup must not be empty`);
      assert.match(payload, /acpx_record_id/);
    }

    // (d) IDEMPOTENCE, measured rather than asserted by construction: a second
    // run over the SAME records finds nothing left to do and writes nothing more.
    saved.length = 0;
    const rerun = await repairAccountSeamRecords(options);
    assert.equal(rerun.repaired.length, 0);
    assert.equal(rerun.alreadyClean, 3, "the two repaired records are now clean, plus pi");
    assert.equal(saved.length, 0);
    assert.match(formatAccountSeamRepairResult(rerun), /nothing to repair/);

    // (e) PER-FIELD COUNTS, and the retained field named in the output. A record
    // count alone cannot be audited field by field.
    const summary = formatAccountSeamRepairResult(result);
    assert.match(summary, /profile cleared: 2/);
    assert.match(summary, /account_switch cleared: 2/);
    assert.match(summary, /subscription cleared: 2/);
    assert.match(summary, /auto_failover DELIBERATELY RETAINED on 1 record/);
  });
});

test("the sweep refuses a record whose backup cannot be taken, and keeps going", async () => {
  await withSweepFixture(async (fixture) => {
    // No file on disk for this record ⇒ the backup read throws. The record must
    // NOT be rewritten (an unbacked-up repair is the one thing forbidden), the
    // failure must be reported, and the sweep must continue to the next record.
    const unbacked = recordFor("rec-missing-file", CODEX, { ...WEDGED_OPTIONS });
    const repairable = recordFor("rec-ok", OPENCODE, { ...WEDGED_OPTIONS });
    await seedRecordFile(fixture.storeDir, repairable);

    const saved: string[] = [];
    const result = await repairAccountSeamRecords({
      backupDir: path.join(fixture.storeDir, "backups"),
      loadRecords: async () => [unbacked, repairable],
      saveRecord: async (record: SessionRecord) => {
        saved.push(record.acpxRecordId);
      },
      storeDir: () => fixture.storeDir,
      isRecordBusy: async () => false,
    });

    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.acpxRecordId, "rec-missing-file");
    assert.equal(
      unbacked.acpx?.session_options?.profile,
      "sub7",
      "a record whose backup failed must not be rewritten",
    );
    assert.deepEqual(saved, ["rec-ok"]);
    assert.match(formatAccountSeamRepairResult(result), /FAILED rec-missing-file/);
  });
});

test("the sweep's summary always states what it SKIPPED, not only what it changed", async () => {
  await withSweepFixture(async (fixture) => {
    const claude = recordFor("rec-claude", CLAUDE_PTY, { ...WEDGED_OPTIONS });
    const result = await repairAccountSeamRecords({
      dryRun: true,
      loadRecords: async () => [claude],
      storeDir: () => fixture.storeDir,
      isRecordBusy: async () => false,
    });
    const summary = formatAccountSeamRepairResult(result);
    assert.match(summary, /skipped 1 Claude-family/);
    assert.match(summary, /would repair 0/);
  });
});

test("the sweep SKIPS a record with a live queue owner, lists it, and never waits on it", async () => {
  await withSweepFixture(async (fixture) => {
    // ⚠️ The stakes: a repair written underneath a live owner can be overwritten
    // by that owner's own checkpoint, or interleave with it — corrupting a LIVE
    // session instead of repairing a dead one. Busy records are skipped, listed,
    // and picked up on a later run.
    const busy = recordFor("rec-busy", CODEX, { ...WEDGED_OPTIONS });
    const idle = recordFor("rec-idle", CODEX, { ...WEDGED_OPTIONS });
    await seedRecordFile(fixture.storeDir, busy);
    await seedRecordFile(fixture.storeDir, idle);

    const saved: string[] = [];
    const options = {
      backupDir: path.join(fixture.storeDir, "backups"),
      loadRecords: async () => [busy, idle],
      saveRecord: async (record: SessionRecord) => {
        saved.push(record.acpxRecordId);
      },
      storeDir: () => fixture.storeDir,
      isRecordBusy: async (record: SessionRecord) => record.acpxRecordId === "rec-busy",
    };

    // The DRY RUN must already exclude it, or the listing reviewed before the
    // write is a different population from the one the write touches.
    const preview = await repairAccountSeamRecords({ ...options, dryRun: true });
    assert.deepEqual(
      preview.repaired.map((entry) => entry.acpxRecordId),
      ["rec-idle"],
    );
    assert.deepEqual(
      preview.skippedBusy.map((entry) => entry.acpxRecordId),
      ["rec-busy"],
    );

    const result = await repairAccountSeamRecords(options);
    assert.deepEqual(saved, ["rec-idle"]);
    assert.equal(busy.acpx?.session_options?.profile, "sub7", "a busy record must not be touched");
    assert.equal(idle.acpx?.session_options?.profile, undefined);
    assert.match(formatAccountSeamRepairResult(result), /SKIPPED \(live owner/);
    assert.match(formatAccountSeamRepairResult(result), /rec-busy/);
  });
});
