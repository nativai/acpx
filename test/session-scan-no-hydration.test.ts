// Brick 38465e2c — the store scans read record BODIES and hydrate only the records they need.
//
// Hydration always starts by stat-ing the record's messages log, so a spy on `fs.stat` names every
// record a scan hydrated. Each row asserts which logs a scan touched (usually none), with a planted
// positive first so an empty list cannot pass because the spy saw nothing at all. The two writers
// (subscription re-pin, account-seam repair) write the BODY back; their rows assert the
// conversation survives, and the two carrier rows at the end pin why that is safe for a checkpoint
// write and not for a boundary write.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { findPinnedSessions, reassignPinnedSessions } from "../src/cli/subscriptions-command.js";
import { SessionResolutionError } from "../src/errors.js";
import { repairAccountSeamRecords } from "../src/session/account-seam-repair.js";
import { exportSession } from "../src/session/export.js";
import { importSession } from "../src/session/import.js";
import { messagesLogFileName, messagesLogPath } from "../src/session/messages-log.js";
import {
  listSessionRecordBodies,
  listSessionsForAgent,
  listSubagentsForSession,
  loadSessionRecordBodyFromIndexEntry,
  listSessionIndexEntries,
  pruneSessions,
  rebuildSessionIndex,
  resolveSessionRecord,
  rollbackTemplateSlug,
  serializeSessionRecordForDisk,
  sessionBaseDir,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const AGENT = "agent";
const LOG_MESSAGES = 3;

type Seed = Partial<SessionRecord> & { acpxRecordId: string };

/** `<id>.json` pointing at a 3-message log, plus that log. */
async function writeRecord(seed: Seed): Promise<void> {
  const dir = sessionBaseDir();
  await fs.mkdir(dir, { recursive: true });
  const record = makeSessionRecord({
    acpSessionId: `${seed.acpxRecordId}-acp`,
    agentCommand: AGENT,
    cwd: dir,
    lastUsedAt: "2026-11-06T00:00:00.000Z",
    ...seed,
  });
  const lines = Array.from(
    { length: LOG_MESSAGES },
    (_, i) =>
      `${JSON.stringify({ Agent: { content: [{ Text: `${seed.acpxRecordId} ${i}` }], tool_results: {} } })}\n`,
  ).join("");
  await fs.writeFile(
    path.join(dir, `${seed.acpxRecordId}.json`),
    `${JSON.stringify({
      ...serializeSessionRecordForDisk(record),
      messages_log: {
        v: 1,
        count: LOG_MESSAGES,
        base_index: 0,
        bytes: Buffer.byteLength(lines),
      },
    })}\n`,
  );
  await fs.writeFile(messagesLogPath(dir, seed.acpxRecordId), lines);
}

async function seed(seeds: Seed[]): Promise<void> {
  for (const one of seeds) {
    await writeRecord(one);
  }
  await rebuildSessionIndex(sessionBaseDir(), "test seed");
}

/** Run `fn`, returning the record ids whose messages log it stat-ed (i.e. hydrated). */
async function hydratedDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const original = fs.stat;
  const ids: string[] = [];
  const suffix = messagesLogFileName("");
  fs.stat = (async (target: Parameters<typeof fs.stat>[0], ...rest: unknown[]) => {
    const name = path.basename(String(target));
    if (name.endsWith(suffix)) {
      ids.push(decodeURIComponent(name.slice(0, -suffix.length)));
    }
    return await (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
  }) as typeof fs.stat;
  try {
    await fn();
  } finally {
    fs.stat = original;
  }
  return ids.toSorted();
}

test("38465e2c: the spy sees a hydration — resolveSessionRecord(id) stats exactly that record's log", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([{ acpxRecordId: "a" }, { acpxRecordId: "b" }]);
    let record: SessionRecord | undefined;
    const hydrated = await hydratedDuring(async () => {
      record = await resolveSessionRecord("a");
    });
    assert.deepEqual(hydrated, ["a"]);
    assert.equal(record?.messages.length, LOG_MESSAGES);
  });
});

test("38465e2c: listSessionsForAgent hydrates nothing and returns listings without messages", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([
      { acpxRecordId: "a", lastUsedAt: "2026-11-06T01:00:00.000Z" },
      { acpxRecordId: "b", lastUsedAt: "2026-11-06T02:00:00.000Z", closed: true },
      { acpxRecordId: "sub", kind: "subagent", parentSessionId: "a" },
      { acpxRecordId: "other", agentCommand: "other" },
    ]);
    let listed: Awaited<ReturnType<typeof listSessionsForAgent>> = [];
    const hydrated = await hydratedDuring(async () => {
      listed = await listSessionsForAgent(AGENT);
    });
    assert.deepEqual(hydrated, []);
    assert.deepEqual(
      listed.map((row) => row.acpxRecordId),
      ["b", "a"],
    );
    for (const row of listed) {
      assert.equal(Object.hasOwn(row, "messages"), false);
    }
  });
});

test("38465e2c: listSessionRecordBodies hydrates nothing and keeps only what `keep` accepts", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([
      { acpxRecordId: "a", lastUsedAt: "2026-11-06T01:00:00.000Z" },
      { acpxRecordId: "b", lastUsedAt: "2026-11-06T02:00:00.000Z" },
      { acpxRecordId: "c", lastUsedAt: "2026-11-06T03:00:00.000Z" },
    ]);
    let kept: SessionRecord[] = [];
    const hydrated = await hydratedDuring(async () => {
      kept = await listSessionRecordBodies((record) => record.acpxRecordId !== "b");
    });
    assert.deepEqual(hydrated, []);
    assert.deepEqual(
      kept.map((record) => record.acpxRecordId),
      ["c", "a"],
    );
  });
});

test("38465e2c: resolveSessionRecord's index legs hydrate only the unique winner, and nothing when ambiguous", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([{ acpxRecordId: "pre-aaa1" }, { acpxRecordId: "pre-bbb1" }, { acpxRecordId: "x" }]);

    let bySuffix: SessionRecord | undefined;
    assert.deepEqual(
      await hydratedDuring(async () => {
        bySuffix = await resolveSessionRecord("bbb1");
      }),
      ["pre-bbb1"],
    );
    assert.equal(bySuffix?.acpxRecordId, "pre-bbb1");
    assert.equal(bySuffix?.messages.length, LOG_MESSAGES);

    let byAcpId: SessionRecord | undefined;
    assert.deepEqual(
      await hydratedDuring(async () => {
        byAcpId = await resolveSessionRecord("pre-aaa1-acp");
      }),
      ["pre-aaa1"],
    );
    assert.equal(byAcpId?.acpxRecordId, "pre-aaa1");

    assert.deepEqual(
      await hydratedDuring(async () => {
        await assert.rejects(resolveSessionRecord("1"), SessionResolutionError);
      }),
      [],
    );
  });
});

test("38465e2c: listSubagentsForSession hydrates only that parent's children", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([
      { acpxRecordId: "p" },
      { acpxRecordId: "c1", kind: "subagent", parentSessionId: "p" },
      { acpxRecordId: "c2", kind: "subagent", parentSessionId: "p" },
      { acpxRecordId: "o1", kind: "subagent", parentSessionId: "q" },
    ]);
    let children: SessionRecord[] = [];
    const hydrated = await hydratedDuring(async () => {
      children = await listSubagentsForSession("p");
    });
    assert.deepEqual(hydrated, ["c1", "c2"]);
    assert.deepEqual(children.map((record) => record.acpxRecordId).toSorted(), ["c1", "c2"]);
    for (const child of children) {
      assert.equal(child.messages.length, LOG_MESSAGES);
    }
  });
});

// A dry run is the whole selection, which is where every candidate used to be hydrated. (A real
// run also stats each log it deletes, to count the bytes freed; that is not a hydration.)
test("38465e2c: pruneSessions selects its candidates without hydrating any", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([
      { acpxRecordId: "a", closed: true, closedAt: "2026-11-01T00:00:00.000Z" },
      { acpxRecordId: "b", closed: true, closedAt: "2026-11-01T00:00:00.000Z" },
      { acpxRecordId: "open" },
    ]);
    let pruned: string[] = [];
    const hydrated = await hydratedDuring(async () => {
      const result = await pruneSessions({
        before: new Date("2027-01-01T00:00:00.000Z"),
        dryRun: true,
      });
      pruned = result.pruned.map((record) => record.acpxRecordId).toSorted();
    });
    assert.deepEqual(hydrated, []);
    assert.deepEqual(pruned, ["a", "b"]);
  });
});

test("38465e2c: templates rollback --delete reads the deleted record's body, not its log", async () => {
  await withTempHome("acpx-scan-", async () => {
    const template = (version: number) => ({
      enabled: true,
      slug: "tpl",
      version,
      created_at: `2026-11-0${version}T00:00:00.000Z`,
    });
    await seed([
      { acpxRecordId: "tpl-v1", closed: true, template: template(1) },
      { acpxRecordId: "tpl-v2", closed: true, template: template(2) },
    ]);
    let outcome: string | undefined;
    const hydrated = await hydratedDuring(async () => {
      outcome = (await rollbackTemplateSlug("tpl", { delete: true })).outcome;
    });
    assert.equal(outcome, "delete");
    assert.deepEqual(hydrated, []);
    await assert.rejects(fs.stat(path.join(sessionBaseDir(), "tpl-v2.json")), { code: "ENOENT" });
  });
});

test("38465e2c: importSession's provider-id check hydrates nothing and still refuses a collision", async () => {
  await withTempHome("acpx-scan-", async (homeDir) => {
    await seed([
      { acpxRecordId: "source", acpSessionId: "provider-1", agentCommand: AGENT_REGISTRY.codex },
      { acpxRecordId: "bystander", agentCommand: AGENT_REGISTRY.codex },
    ]);
    const archivePath = path.join(homeDir, "archive.json");
    await exportSession({ sessionId: "source" }, archivePath);
    const hydrated = await hydratedDuring(async () => {
      await assert.rejects(importSession(archivePath), { code: "session-provider-exists" });
    });
    assert.deepEqual(hydrated, []);
  });
});

function pinnedTo(profile: string): Partial<SessionRecord> {
  return { acpx: { session_options: { profile } } } as Partial<SessionRecord>;
}

async function messagesOnDisk(id: string): Promise<number> {
  return (await resolveSessionRecord(id)).messages.length;
}

async function logBytes(id: string): Promise<string> {
  return await fs.readFile(messagesLogPath(sessionBaseDir(), id), "utf8");
}

test("38465e2c: subscription remove finds pins from bodies and re-pins without losing the conversation", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([
      { acpxRecordId: "pinned", ...pinnedTo("sub7") },
      { acpxRecordId: "elsewhere", ...pinnedTo("sub8") },
      { acpxRecordId: "unpinned" },
    ]);
    let pinned: Awaited<ReturnType<typeof findPinnedSessions>> = [];
    assert.deepEqual(
      await hydratedDuring(async () => {
        pinned = await findPinnedSessions("sub7");
      }),
      [],
    );
    assert.deepEqual(
      pinned.map((entry) => [entry.record.acpxRecordId, entry.matchesProfile]),
      [["pinned", true]],
    );
    const logBefore = await logBytes("pinned");
    assert.equal(await reassignPinnedSessions(pinned, "sub9"), 1);
    assert.equal(await logBytes("pinned"), logBefore);
    const after = await resolveSessionRecord("pinned");
    assert.equal(after.acpx?.session_options?.profile, "sub9");
    assert.equal(after.messages.length, LOG_MESSAGES, "the re-pin kept the conversation");
  });
});

test("38465e2c: the account-seam sweep scans bodies and repairs without losing the conversation", async () => {
  await withTempHome("acpx-scan-", async (homeDir) => {
    const codex = "node /opt/codex-acp/dist/index.js";
    await seed([
      { acpxRecordId: "wedged", agentCommand: codex, ...pinnedTo("sub7") },
      { acpxRecordId: "clean", agentCommand: codex },
      { acpxRecordId: "claude", agentCommand: "node /opt/claude-agent-acp/dist/index.js" },
    ]);
    const options = { backupDir: path.join(homeDir, "backup"), isRecordBusy: async () => false };
    assert.deepEqual(
      await hydratedDuring(async () => {
        const preview = await repairAccountSeamRecords({ ...options, dryRun: true });
        assert.equal(preview.scanned, 3);
        assert.deepEqual(
          preview.repaired.map((entry) => entry.acpxRecordId),
          ["wedged"],
        );
      }),
      [],
    );
    const logBefore = await logBytes("wedged");
    const result = await repairAccountSeamRecords(options);
    assert.deepEqual(result.failures, []);
    assert.equal(result.repaired.length, 1);
    assert.equal(await logBytes("wedged"), logBefore);
    const after = await resolveSessionRecord("wedged");
    assert.equal(after.acpx?.session_options?.profile, undefined);
    assert.equal(after.messages.length, LOG_MESSAGES, "the repair kept the conversation");
  });
});

// The carriers for the note on `listSessionRecordBodies`. A body's `messages` hold only the inline
// tail (none, for this split-tail record), so a body is safe to write back only through a write that
// leaves the log alone.
async function loadBody(id: string): Promise<SessionRecord> {
  const entry = (await listSessionIndexEntries()).find((one) => one.acpxRecordId === id);
  assert.ok(entry);
  const body = await loadSessionRecordBodyFromIndexEntry(entry);
  assert.ok(body);
  assert.equal(body.messages.length, 0, "a split-tail body carries no inline messages");
  return body;
}

test("38465e2c: a CHECKPOINT write of a body round-trips the conversation (why the writers may)", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([{ acpxRecordId: "a" }]);
    const logBefore = await logBytes("a");
    await writeSessionRecord(await loadBody("a"));
    assert.equal(await logBytes("a"), logBefore);
    assert.equal(await messagesOnDisk("a"), LOG_MESSAGES);
  });
});

test("38465e2c: a BOUNDARY write of a body erases the conversation (why nothing may)", async () => {
  await withTempHome("acpx-scan-", async () => {
    await seed([{ acpxRecordId: "a" }]);
    const previous = process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES;
    // Compaction runs only past the threshold (32 MB); lower it so this small log is past it.
    process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES = "1";
    try {
      await writeSessionRecordAtBoundary(await loadBody("a"));
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES;
      } else {
        process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES = previous;
      }
    }
    assert.equal(await messagesOnDisk("a"), 0);
  });
});
