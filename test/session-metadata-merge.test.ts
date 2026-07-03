import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeMetadataForPersist,
  type MetadataBaseline,
} from "../src/session/persistence/metadata-merge.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

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
      cwd: "/tmp/metadata-merge",
    }),
    ...overrides,
  };
}

test("mergeMetadataForPersist keeps persisted keys the owner did not change", () => {
  const baseline: MetadataBaseline = {
    metadata: { brick: "owner-brick", task_folder: "/owner/task" },
  };

  assert.deepEqual(
    mergeMetadataForPersist({
      baseline,
      current: { brick: "owner-brick", task_folder: "/owner/task" },
      persisted: {
        brick: "external-brick",
        task_folder: "/external/task",
        byway: "1",
      },
    }),
    {
      brick: "external-brick",
      task_folder: "/external/task",
      byway: "1",
    },
  );
});

test("mergeMetadataForPersist lets owner writes beat persisted values for changed keys", () => {
  const baseline: MetadataBaseline = {
    metadata: { brick: "old-brick", task_folder: "/old/task" },
  };

  assert.deepEqual(
    mergeMetadataForPersist({
      baseline,
      current: { brick: "owner-brick", task_folder: "/old/task" },
      persisted: {
        brick: "external-brick",
        task_folder: "/external/task",
        byway: "1",
      },
    }),
    {
      brick: "owner-brick",
      task_folder: "/external/task",
      byway: "1",
    },
  );
});

test("mergeMetadataForPersist clears only keys the owner explicitly removed", () => {
  const baseline: MetadataBaseline = {
    metadata: { brick: "old-brick", task_folder: "/old/task" },
  };

  assert.deepEqual(
    mergeMetadataForPersist({
      baseline,
      current: { task_folder: "/old/task" },
      persisted: {
        brick: "external-brick",
        task_folder: "/external/task",
        byway: "1",
      },
    }),
    {
      task_folder: "/external/task",
      byway: "1",
    },
  );
});

test("mergeMetadataForPersist without a baseline overlays current keys without clearing disk keys", () => {
  assert.deepEqual(
    mergeMetadataForPersist({
      current: { task_folder: "/owner/task" },
      persisted: { brick: "external-brick" },
    }),
    { brick: "external-brick", task_folder: "/owner/task" },
  );
});

test("writeSessionRecordWithPersistedLifecycle rereads metadata before persisting", async () => {
  await withTempHome("acpx-metadata-merge-", async () => {
    const persistence = await loadPersistence();
    const owner = record("fresh-metadata", {
      metadata: { brick: "old-brick", task_folder: "/old/task" },
    });
    await persistence.writeSessionRecord(owner);

    const staleOwnerRecord = await persistence.resolveSessionRecord("fresh-metadata");
    const staleLifecycle = await persistence.readPersistedLifecycle("fresh-metadata");
    assert.equal(staleLifecycle?.metadata?.brick, "old-brick");

    const external = await persistence.resolveSessionRecord("fresh-metadata");
    external.metadata = {
      ...external.metadata,
      brick: "external-brick",
      task_folder: "/external/task",
      external: "keep",
    };
    await persistence.writeSessionRecord(external);

    staleOwnerRecord.lastUsedAt = "2026-07-03T00:00:00.000Z";
    await persistence.writeSessionRecordWithPersistedLifecycle(staleOwnerRecord, staleLifecycle);

    const onDisk = await persistence.resolveSessionRecord("fresh-metadata");
    assert.deepEqual(onDisk.metadata, {
      brick: "external-brick",
      task_folder: "/external/task",
      external: "keep",
    });
    assert.equal(onDisk.lastUsedAt, "2026-07-03T00:00:00.000Z");
  });
});
