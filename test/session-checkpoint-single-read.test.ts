import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// perf-loadfix W2.4 — the checkpoint path passes one pre-read lifecycle
// snapshot through to the write path. W11 intentionally rereads metadata inside
// that write, but the lifecycle-clobber protection (another process's
// closed/favorite/name write survives our checkpoint) must still behave exactly
// like the re-reading writeSessionRecord (annex D4).

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

test("a concurrent lifecycle write survives a checkpoint using a pre-read lifecycle", async () => {
  await withTempHome("acpx-single-read-", async () => {
    const persistence = await loadPersistence();
    const checkpointing = record("clobber-guard");
    await persistence.writeSessionRecord(checkpointing);

    // "Process B": close + favorite + rename the session on disk.
    const fromB = record("clobber-guard", {
      closed: true,
      closedAt: "2026-06-12T08:00:00.000Z",
      favorite: true,
      favoritedAt: "2026-06-12T08:00:01.000Z",
      name: "renamed-by-b",
    });
    await persistence.writeSessionRecordWithLifecycle(fromB);

    // "Process A" checkpoints: one read feeds both merge and write.
    const persisted = await persistence.readPersistedLifecycle("clobber-guard");
    assert.equal(persisted?.closed, true);
    checkpointing.lastUsedAt = "2026-06-12T08:00:02.000Z";
    await persistence.writeSessionRecordWithPersistedLifecycle(checkpointing, persisted);

    const onDisk = await persistence.resolveSessionRecord("clobber-guard");
    assert.equal(onDisk.closed, true, "B's closed must survive A's checkpoint");
    assert.equal(onDisk.closedAt, "2026-06-12T08:00:00.000Z");
    assert.equal(onDisk.favorite, true, "B's favorite must survive A's checkpoint");
    assert.equal(onDisk.favoritedAt, "2026-06-12T08:00:01.000Z");
    assert.equal(onDisk.name, "renamed-by-b", "B's rename must survive A's checkpoint");
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

test("an undefined persisted lifecycle means no prior state: the record writes as-is", async () => {
  await withTempHome("acpx-single-read-", async () => {
    const persistence = await loadPersistence();
    const rec = record("fresh-write", { name: "fresh-name" });
    await persistence.writeSessionRecordWithPersistedLifecycle(rec, undefined);

    const onDisk = await persistence.resolveSessionRecord("fresh-write");
    assert.equal(onDisk.name, "fresh-name");
    assert.equal(onDisk.closed, false);
  });
});

test("pass-through variant matches the re-reading variant byte-for-byte", async () => {
  await withTempHome("acpx-single-read-", async (homeDir) => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const persistence = await loadPersistence();
    const recordPath = path.join(homeDir, ".acpx", "sessions", "parity.json");

    const base = record("parity");
    await persistence.writeSessionRecord(base);
    const closed = record("parity", { closed: true, closedAt: "2026-06-12T09:00:00.000Z" });
    await persistence.writeSessionRecordWithLifecycle(closed);

    const checkpointing = record("parity", { lastUsedAt: "2026-06-12T09:00:01.000Z" });

    // Variant 1: classic re-reading write.
    await persistence.writeSessionRecord({ ...checkpointing });
    const classic = await fs.readFile(recordPath, "utf8");

    // Variant 2: pass-through write with a fresh pre-read.
    const persisted = await persistence.readPersistedLifecycle("parity");
    await persistence.writeSessionRecordWithPersistedLifecycle({ ...checkpointing }, persisted);
    const passThrough = await fs.readFile(recordPath, "utf8");

    assert.equal(passThrough, classic);
  });
});
