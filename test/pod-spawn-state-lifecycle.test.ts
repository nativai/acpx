import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import {
  applyArchiveRun,
  createContext,
  planArchiveRun,
  runRestore,
} from "../src/session/archive/operations.js";
import { resolveBoundaries, scanSessionDir } from "../src/session/archive/retention.js";
import {
  fileExists,
  makeSessionRecord,
  sessionFilePath,
  withTempDir,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// block A7 / O1 (atrium S7 TE): `<id>.spawn-state` rides with its record through archive, restore and
// delete; a LONE spawn-state (no record, hot or archived) is residue — removed on apply with one line.
// The name is not `.json`, so no enumerator reads it as a record (A-13; pinned in pod-spawn-state.test.ts).

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const OLD_MS = 30 * 24 * 60 * 60 * 1000;
const STATE = JSON.stringify({ v: 1, record_id: ID });

async function writeClosedRecord(hotDir: string, id: string): Promise<void> {
  const file = path.join(hotDir, `${id}.json`);
  const closedAt = new Date(Date.now() - OLD_MS).toISOString();
  await fs.writeFile(
    file,
    JSON.stringify({
      acpx_record_id: id,
      closed: true,
      closed_at: closedAt,
      last_used_at: closedAt,
      cwd: "/tmp",
    }),
    "utf8",
  );
  const old = new Date(Date.now() - OLD_MS);
  await fs.utimes(file, old, old);
}

async function writeSpawnState(dir: string, id: string): Promise<string> {
  const file = path.join(dir, `${id}.spawn-state`);
  await fs.writeFile(file, STATE, "utf8");
  const old = new Date(Date.now() - OLD_MS);
  await fs.utimes(file, old, old);
  return file;
}

async function archiveRun(hotDir: string, options: { dryRun: boolean; includeOrphans?: boolean }) {
  const context = createContext(hotDir, "a7");
  const boundaries = resolveBoundaries(context.nowMs);
  const plan = await planArchiveRun(context, boundaries, {
    includeOrphans: options.includeOrphans ?? false,
    liveness: { primary: undefined, wakeups: await loadWakeupLiveness(hotDir) },
  });
  const result = await applyArchiveRun({
    context,
    boundaries,
    plan,
    dryRun: options.dryRun,
    allowFirstRun: true,
  });
  return { context, plan, result };
}

test("archive moves <id>.spawn-state with its record; restore brings the pair back", async () => {
  await withTempDir("acpx-a7-archive-", async (hotDir) => {
    await writeClosedRecord(hotDir, ID);
    const state = await writeSpawnState(hotDir, ID);
    const { context, result } = await archiveRun(hotDir, { dryRun: false });
    assert.deepEqual(result.failures, []);
    assert.equal(result.moved.length, 1);
    assert.equal(await fileExists(state), false, "gone from the hot dir");
    assert.equal(await fileExists(path.join(hotDir, `${ID}.json`)), false);
    assert.equal(
      await fileExists(path.join(context.archiveDir, `${ID}.spawn-state`)),
      true,
      "in the archive beside its record",
    );
    assert.equal(await fileExists(path.join(context.archiveDir, `${ID}.json`)), true);

    const restored = await runRestore(createContext(hotDir, "a7-restore"), [ID]);
    assert.deepEqual(restored.failures, []);
    assert.equal(await fileExists(state), true, "back in the hot dir");
    assert.equal(await fileExists(path.join(hotDir, `${ID}.json`)), true);
    assert.equal(await fs.readFile(state, "utf8"), STATE, "byte for byte");
    assert.equal(await fileExists(path.join(context.archiveDir, `${ID}.spawn-state`)), false);
  });
});

test("a LONE spawn-state is not an orphan id: the scan sets it apart, even under --orphans", async () => {
  await withTempDir("acpx-a7-lone-scan-", async (hotDir) => {
    await writeClosedRecord(hotDir, OTHER);
    await writeSpawnState(hotDir, ID);
    const scan = await scanSessionDir(hotDir);
    assert.deepEqual(scan.loneSpawnStates, [`${ID}.spawn-state`]);
    assert.deepEqual(scan.orphans, [], "not an orphan");
    assert.deepEqual(scan.ignoredFiles, []);
    // NEGATIVE twin: with a record beside it the same file is part of that id, not lone.
    await writeClosedRecord(hotDir, ID);
    const withRecord = await scanSessionDir(hotDir);
    assert.deepEqual(withRecord.loneSpawnStates, []);
    assert.ok(
      withRecord.candidates.some(
        (candidate) =>
          candidate.id === ID &&
          candidate.files.includes(`${ID}.spawn-state`) &&
          candidate.files.includes(`${ID}.json`),
      ),
    );
    // NEGATIVE: an orphan set that has OTHER files too is still an orphan (the lone rule is exact).
    await fs.rm(path.join(hotDir, `${ID}.json`));
    await fs.writeFile(path.join(hotDir, `${ID}.messages.ndjson`), "{}\n");
    const mixed = await scanSessionDir(hotDir);
    assert.deepEqual(mixed.loneSpawnStates, []);
    assert.equal(mixed.orphans.length, 1);
    assert.deepEqual(mixed.orphans[0].files, [`${ID}.messages.ndjson`, `${ID}.spawn-state`]);
  });
});

test("O1: a lone spawn-state is removed on apply with ONE line; a dry run only says it would", async () => {
  await withTempDir("acpx-a7-lone-apply-", async (hotDir) => {
    await writeClosedRecord(hotDir, OTHER);
    const lone = await writeSpawnState(hotDir, ID);
    const dry = await archiveRun(hotDir, { dryRun: true });
    assert.equal(await fileExists(lone), true, "a dry run removes nothing");
    assert.deepEqual(
      dry.result.warnings.filter((line) => line.includes("spawn-state")),
      [`lone spawn-state ${ID}.spawn-state (no record) would be removed on apply`],
    );
    const applied = await archiveRun(hotDir, { dryRun: false, includeOrphans: true });
    assert.equal(await fileExists(lone), false, "removed");
    assert.deepEqual(
      applied.result.warnings.filter((line) => line.includes("spawn-state")),
      [`removed orphan spawn-state ${ID}.spawn-state: no record, hot or archived`],
    );
    // it was removed, NOT archived as an orphan
    assert.equal(
      await fileExists(path.join(applied.context.archiveDir, `${ID}.spawn-state`)),
      false,
    );
    // the other id's own archive is untouched by the removal
    assert.equal(applied.result.moved.length, 1);
  });
});

test("O1 NEGATIVE: a lone spawn-state whose record is ARCHIVED stays (restore brings the pair together)", async () => {
  await withTempDir("acpx-a7-lone-archived-", async (hotDir) => {
    await writeClosedRecord(hotDir, ID);
    const first = await archiveRun(hotDir, { dryRun: false });
    assert.equal(first.result.moved.length, 1);
    const lone = await writeSpawnState(hotDir, ID);
    const second = await archiveRun(hotDir, { dryRun: false, includeOrphans: true });
    assert.equal(await fileExists(lone), true, "kept: its record exists in the archive");
    assert.deepEqual(
      second.result.warnings.filter((line) => line.includes("spawn-state")),
      [],
    );
    // and the restore of that id then takes it as the record's own
    const restored = await runRestore(createContext(hotDir, "a7-restore-2"), [ID]);
    assert.deepEqual(restored.failures, []);
    assert.equal(await fileExists(path.join(hotDir, `${ID}.json`)), true);
    assert.equal(await fileExists(lone), true);
  });
});

test("O1 NEGATIVE: a record that appears between the scan and the removal saves the file", async () => {
  await withTempDir("acpx-a7-lone-race-", async (hotDir) => {
    const lone = await writeSpawnState(hotDir, ID);
    const context = createContext(hotDir, "a7-race");
    const boundaries = resolveBoundaries(context.nowMs);
    const plan = await planArchiveRun(context, boundaries, {
      includeOrphans: false,
      liveness: { primary: undefined, wakeups: await loadWakeupLiveness(hotDir) },
    });
    assert.deepEqual(plan.loneSpawnStates, [`${ID}.spawn-state`]);
    await writeClosedRecord(hotDir, ID); // the record lands after the plan
    const result = await applyArchiveRun({
      context,
      boundaries,
      plan,
      dryRun: false,
      allowFirstRun: true,
    });
    assert.equal(await fileExists(lone), true, "re-checked right before the removal");
    assert.deepEqual(
      result.warnings.filter((line) => line.includes("spawn-state")),
      [],
    );
  });
});

for (const includeHistory of [true, false]) {
  test(`prune takes <id>.spawn-state with its record (record tier; includeHistory=${includeHistory})`, async () => {
    await withTempHome("acpx-a7-prune-", async (homeDir) => {
      const session = await import("../src/session/session.js");
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecord(
          {
            acpxRecordId: ID,
            acpSessionId: ID,
            agentCommand: "agent-a",
            cwd: path.join(homeDir, "workspace"),
            closed: true,
            closedAt: "2026-01-01T00:00:00.000Z",
          },
          { defaultAcpx: false },
        ),
      );
      const state = await writeSpawnState(path.dirname(sessionFilePath(homeDir, ID)), ID);
      const bystander = await writeSpawnState(path.dirname(sessionFilePath(homeDir, ID)), OTHER);
      assert.equal(await fileExists(state), true);
      const result = await session.pruneSessions({ agentCommand: "agent-a", includeHistory });
      assert.equal(result.pruned.length, 1);
      assert.equal(await fileExists(sessionFilePath(homeDir, ID)), false);
      assert.equal(await fileExists(state), false, "the spawn-state went with its record");
      assert.equal(await fileExists(bystander), true, "another id's file is not touched");
      assert.ok(result.bytesFreed >= Buffer.byteLength(STATE), "its bytes are counted");
    });
  });
}
