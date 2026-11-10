/**
 * `acpx.sleeping` only ever goes one way: nothing may put it back on a record that was woken
 * (brick://56d160be).
 *
 * The turn's live checkpoint assigns the `record.acpx` it cloned when the turn loaded the record
 * and writes it. A first wake deletes the flag from the record mid-turn, so a checkpoint (or a
 * failing turn's closing writes) landing after the wake wrote `acp_session_id` AND `sleeping`
 * together — the list and `status` showed "Sleeping" for a session that had run. Reproduced on
 * dev 25f39d84 with the real claude adapter (`--model`'s apply window; a turn failing right after
 * the wake, `MODEL_NOT_ADVERTISED`, left it every time).
 */
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";
import { makeBox, readRecord, runCli } from "./umq-rig.js";

type PersistenceModule = typeof import("../src/session/persistence.js");

async function loadPersistence(): Promise<PersistenceModule> {
  return await import("../src/session/persistence.js");
}

const SINCE = "2026-11-09T10:00:00.000Z";
const WOKEN = "acp-woken-session";

type RawRecord = { acp_session_id: string; acpx?: { sleeping?: unknown } };

async function readRaw(home: string, id: string): Promise<RawRecord> {
  return JSON.parse(await fs.readFile(sessionFilePath(home, id), "utf8")) as RawRecord;
}

function sleepingRecord(id: string, cwd: string): SessionRecord {
  return makeSessionRecord(
    { acpxRecordId: id, acpSessionId: "", agentCommand: "agent", cwd },
    { defaultAcpx: false },
  );
}

/** What `sessions new --sleeping` writes, then what a turn loads: a parsed record off the disk. */
async function loadSleeping(
  persistence: PersistenceModule,
  id: string,
  cwd: string,
): Promise<SessionRecord> {
  const created = sleepingRecord(id, cwd);
  created.acpx = { sleeping: { since: SINCE } };
  await persistence.writeSessionRecord(created);
  return await persistence.resolveSessionRecord(id);
}

/** The first wake's last step (`finishSleepingMaterialisation`): the agent session is named, the flag goes. */
async function materialise(persistence: PersistenceModule, record: SessionRecord): Promise<void> {
  record.acpSessionId = WOKEN;
  delete record.acpx?.sleeping;
  await persistence.writeSessionRecordAtBoundaryNow(record);
}

const WRITERS = [
  ["writeSessionRecord (the live checkpoint)", "writeSessionRecord"],
  [
    "writeSessionRecordAtBoundary (a turn-end / prompt-start write)",
    "writeSessionRecordAtBoundary",
  ],
  [
    "writeSessionRecordAtBoundaryNow (a second materialisation write)",
    "writeSessionRecordAtBoundaryNow",
  ],
] as const;

for (const [label, writer] of WRITERS) {
  test(`stale pre-wake acpx written AFTER the materialisation: ${label} does not put \`sleeping\` back`, async () => {
    await withTempHome("acpx-sleeping-writer-", async (home) => {
      const persistence = await loadPersistence();
      const record = await loadSleeping(persistence, `stale-same-${writer}`, home);
      // The turn's `acpxState`: cloned at load, BEFORE the wake — flag included.
      const stale = cloneSessionAcpxState(record.acpx);
      assert.ok(stale?.sleeping, "the turn's copy still says sleeping");

      await materialise(persistence, record);
      assert.equal((await readRaw(home, record.acpxRecordId)).acpx?.sleeping, undefined);

      // What `mergeLatestDurablePreferences` does: `record.acpx = acpxState`, then writes.
      record.acpx = stale;
      await persistence[writer](record);

      const onDisk = await readRaw(home, record.acpxRecordId);
      assert.equal(onDisk.acp_session_id, WOKEN, "the woken session id is kept");
      assert.equal(onDisk.acpx?.sleeping, undefined, "the flag stays gone");
      assert.equal(record.acpx?.sleeping, undefined, "and the turn's own object lost it too");
    });
  });
}

test("a stale record object loaded BEFORE another process woke the session cannot put `sleeping` back", async () => {
  await withTempHome("acpx-sleeping-writer-", async (home) => {
    const persistence = await loadPersistence();
    const id = "stale-other-object";
    const staleHolder = await loadSleeping(persistence, id, home);
    // Another writer wakes it (the owner's materialisation, on its own record object).
    const waker = await persistence.resolveSessionRecord(id);
    await materialise(persistence, waker);

    // The holder noticed the session id (as the turn does) and writes its pre-wake acpx.
    staleHolder.acpSessionId = WOKEN;
    await persistence.writeSessionRecord(staleHolder);

    const onDisk = await readRaw(home, id);
    assert.equal(onDisk.acp_session_id, WOKEN);
    assert.equal(onDisk.acpx?.sleeping, undefined, "disk wins: it was woken");
  });
});

test("negative: a deliberate sleeping create is written verbatim, and a sleeping record's own later writes keep the flag", async () => {
  await withTempHome("acpx-sleeping-writer-", async (home) => {
    const persistence = await loadPersistence();
    const id = "still-asleep";

    // `sessions new --sleeping`: a brand-new record, no file yet — the flag must land.
    const record = await loadSleeping(persistence, id, home);
    assert.deepEqual((await readRaw(home, id)).acpx?.sleeping, { since: SINCE });

    // Its own later writes (an index refresh, a seat write, a checkpoint) while it still sleeps.
    record.lastUsedAt = "2026-11-09T11:00:00.000Z";
    await persistence.writeSessionRecord(record);
    await persistence.writeSessionRecordAtBoundary(record);
    await persistence.writeSessionRecordAtBoundaryNow(record);
    const onDisk = await readRaw(home, id);
    assert.deepEqual(onDisk.acpx?.sleeping, { since: SINCE }, "still sleeping");
    assert.equal(onDisk.acp_session_id, "");

    // A sleeping copy (`sessions copy --sleeping`) keeps its template link on disk too.
    const copy = sleepingRecord("sleeping-copy", home);
    copy.acpx = { sleeping: { since: SINCE, fork: { from: "template-record" } } };
    await persistence.writeSessionRecord(copy);
    assert.deepEqual((await readRaw(home, "sleeping-copy")).acpx?.sleeping, {
      since: SINCE,
      fork: { from: "template-record" },
    });
  });
});

// The real path: the queue owner's turn, the mock adapter as the agent, no stubbed writer. The turn
// is made to fail the way the real-adapter reproduction did — right AFTER the wake materialised the
// record — by asking for a model the adapter does not advertise (`applyPromptModelIfAdvertised`
// throws once the connect is done). The turn's closing writes then carry its pre-wake `acpxState`.
test("real turn: a wake whose turn fails right after the materialisation leaves the session woken, never sleeping beside its session id", async () => {
  const f = makeBox({ requestMib: 4000, withMockExtraArgs: ["--advertise-models"] });
  const args = ["--agent", f.agent, "--cwd", path.join(f.root, "work"), "--approve-all"];
  const created = await runCli(
    [...args, "--format", "json", "sessions", "new", "--sleeping"],
    { ...f.env, ACPX_ADMISSION_CLASS: "automation" },
    f.root,
  );
  assert.equal(created.code, 0, created.stderr);
  const id = (
    JSON.parse(created.stdout.trim().split("\n").at(-1) ?? "{}") as { acpxRecordId: string }
  ).acpxRecordId;
  const before = readRecord(f, id) as { acp_session_id: string; acpx: { sleeping?: unknown } };
  assert.equal(before.acp_session_id, "");
  assert.ok(before.acpx.sleeping, "created sleeping");

  const wake = await runCli(
    [...args, "--model", "ghost-model-nobody-advertises", "prompt", "--session-id", id, "hello"],
    f.env,
    f.root,
  );
  assert.notEqual(wake.code, 0, "the turn failed after the wake");

  const after = readRecord(f, id) as { acp_session_id: string; acpx: { sleeping?: unknown } };
  assert.notEqual(after.acp_session_id, "", `the wake materialised it: ${wake.stderr}`);
  assert.equal(after.acpx.sleeping, undefined, "and it is no longer marked sleeping");
});
