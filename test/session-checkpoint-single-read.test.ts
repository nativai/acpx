import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// The lifecycle-clobber protection: another process's closed/favorite/name write
// survives our checkpoint. Until 2026-10-05 the checkpoint passed a lifecycle
// snapshot it had read BEFORE its flush into the write (perf-loadfix W2.4); that
// snapshot is gone — the write rereads the record right before its rename
// (brick eb4c8d06) — so these rows drive the one remaining write path.

type PersistenceModule = typeof import("../src/session/persistence.js");

async function loadPersistence(): Promise<PersistenceModule> {
  return await import("../src/session/persistence.js");
}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ...makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: "agent",
      cwd: "/tmp/single-read",
    }),
    ...overrides,
  };
}

test("a concurrent lifecycle write survives a checkpoint whose owner read the record before it", async () => {
  await withTempHome("acpx-single-read-", async () => {
    const persistence = await loadPersistence();
    const checkpointing = record("clobber-guard");
    await persistence.writeSessionRecord(checkpointing);

    // "Process B": close + favorite the session on disk.
    const fromB = record("clobber-guard", {
      closed: true,
      closedAt: "2026-06-12T08:00:00.000Z",
      favorite: true,
      favoritedAt: "2026-06-12T08:00:01.000Z",
    });
    await persistence.writeSessionRecordWithLifecycle(fromB);

    // "Process A" checkpoints the record object it loaded BEFORE B's write.
    checkpointing.lastUsedAt = "2026-06-12T08:00:02.000Z";
    await persistence.writeSessionRecord(checkpointing);

    const onDisk = await persistence.resolveSessionRecord("clobber-guard");
    assert.equal(onDisk.closed, true, "B's closed must survive A's checkpoint");
    assert.equal(onDisk.closedAt, "2026-06-12T08:00:00.000Z");
    assert.equal(onDisk.favorite, true, "B's favorite must survive A's checkpoint");
    assert.equal(onDisk.favoritedAt, "2026-06-12T08:00:01.000Z");
    assert.equal(onDisk.lastUsedAt, "2026-06-12T08:00:02.000Z", "A's payload still lands");
  });
});

test("readPersistedLifecycle carries pid and acpx for the closed-state merge", async () => {
  await withTempHome("acpx-single-read-", async () => {
    const persistence = await loadPersistence();
    const rec = record("merge-fields", {
      pid: 4242,
      acpx: { current_model_id: "model-x" },
    });
    await persistence.writeSessionRecord(rec);

    const persisted = await persistence.readPersistedLifecycle("merge-fields");
    assert.equal(persisted?.pid, 4242);
    assert.equal(persisted?.acpx?.current_model_id, "model-x");
  });
});

test("no record on disk means no prior state: the record writes as-is", async () => {
  await withTempHome("acpx-single-read-", async () => {
    const persistence = await loadPersistence();
    const rec = record("fresh-write", { title: "fresh-title" });
    await persistence.writeSessionRecord(rec);

    const onDisk = await persistence.resolveSessionRecord("fresh-write");
    assert.equal(onDisk.title, "fresh-title");
    assert.equal(onDisk.closed, false);
  });
});
