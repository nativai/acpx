import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readSessionIndex, sessionIndexPath } from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// perf-loadfix W2.3 — membership-immediate / scalar-throttled index writes +
// compact JSON for index.json and session records.

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
      cwd: "/tmp/write-policy",
    }),
    ...overrides,
  };
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

test("a new session's membership reaches index.json immediately", async () => {
  await withTempHome("acpx-write-policy-", async (homeDir) => {
    const persistence = await loadPersistence();
    await persistence.writeSessionRecord(record("new-session"));

    const index = await readSessionIndex(sessionsDir(homeDir));
    assert.ok(index, "index.json must exist right after the first write");
    assert.deepEqual(index.files, ["new-session.json"]);
    assert.equal(index.entries[0]?.acpxRecordId, "new-session");
  });
});

test("rapid same-file rewrites coalesce: at most one persisted index write per window", async () => {
  await withTempHome("acpx-write-policy-", async (homeDir) => {
    const persistence = await loadPersistence();
    const dir = sessionsDir(homeDir);
    const rec = record("hot-session");
    await persistence.writeSessionRecord(rec); // membership-immediate
    const statAfterFirst = await fs.stat(sessionIndexPath(dir));

    // Checkpoint-stream simulation: repeat writes of the same file within the
    // 5 s window must NOT rewrite index.json (they queue as pending scalars).
    for (let i = 0; i < 5; i += 1) {
      rec.lastUsedAt = `2026-06-0${i + 1}T00:00:00.000Z`;
      await persistence.writeSessionRecord(rec);
    }
    const statAfterBurst = await fs.stat(sessionIndexPath(dir));
    assert.equal(
      statAfterFirst.mtimeMs,
      statAfterBurst.mtimeMs,
      "index.json must not be rewritten per checkpoint within the throttle window",
    );

    // The explicit flush (owner-exit path) persists the latest pending entry.
    await persistence.flushPendingSessionIndexUpdates(dir);
    const index = await readSessionIndex(dir);
    assert.equal(
      index?.entries.find((entry) => entry.file === "hot-session.json")?.lastUsedAt,
      "2026-06-05T00:00:00.000Z",
      "flush must write the LATEST pending entry (last-wins coalescing)",
    );
  });
});

test("same-process index reads see pending scalar updates (read-your-writes)", async () => {
  await withTempHome("acpx-write-policy-", async (homeDir) => {
    const persistence = await loadPersistence();
    const rec = record("ryw-session");
    await persistence.writeSessionRecord(rec);
    rec.lastUsedAt = "2026-06-09T00:00:00.000Z";
    await persistence.writeSessionRecord(rec); // pending scalar

    const sessions = await persistence.listSessions();
    assert.equal(sessions[0]?.lastUsedAt, "2026-06-09T00:00:00.000Z");
    // And the read drained the pending update to disk.
    const index = await readSessionIndex(sessionsDir(homeDir));
    assert.equal(index?.entries[0]?.lastUsedAt, "2026-06-09T00:00:00.000Z");
  });
});

test("privileged lifecycle writes (close) reach index.json immediately", async () => {
  await withTempHome("acpx-write-policy-", async (homeDir) => {
    const persistence = await loadPersistence();
    const rec = record("close-session");
    await persistence.writeSessionRecord(rec);

    const closed = record("close-session", {
      closed: true,
      closedAt: "2026-06-10T00:00:00.000Z",
    });
    await persistence.writeSessionRecordWithLifecycle(closed);

    const index = await readSessionIndex(sessionsDir(homeDir));
    assert.equal(
      index?.entries.find((entry) => entry.file === "close-session.json")?.closed,
      true,
      "lifecycle write must not sit in the scalar queue",
    );
  });
});

test("index.json and session records are written compact and parse identically", async () => {
  await withTempHome("acpx-write-policy-", async (homeDir) => {
    const persistence = await loadPersistence();
    await persistence.writeSessionRecord(record("compact-session"));

    const dir = sessionsDir(homeDir);
    const indexRaw = await fs.readFile(sessionIndexPath(dir), "utf8");
    const recordRaw = await fs.readFile(path.join(dir, "compact-session.json"), "utf8");
    // Compact: single line + trailing newline, no pretty-print indentation.
    assert.equal(indexRaw.trimEnd().includes("\n"), false, "index.json must be compact");
    assert.equal(recordRaw.trimEnd().includes("\n"), false, "record must be compact");
    // Still plain JSON for every consumer.
    assert.equal((JSON.parse(indexRaw) as { schema: string }).schema, "acpx.session-index.v1");
    assert.equal(
      (JSON.parse(recordRaw) as { acpx_record_id: string }).acpx_record_id,
      "compact-session",
    );
  });
});

test("a pending entry whose file was pruned by another process is not resurrected", async () => {
  await withTempHome("acpx-write-policy-", async (homeDir) => {
    const persistence = await loadPersistence();
    const dir = sessionsDir(homeDir);
    const rec = record("doomed-session");
    await persistence.writeSessionRecord(rec);
    rec.lastUsedAt = "2026-06-11T00:00:00.000Z";
    await persistence.writeSessionRecord(rec); // pending scalar

    // Simulate an external pruner removing the record file.
    await fs.unlink(path.join(dir, "doomed-session.json"));
    await persistence.flushPendingSessionIndexUpdates(dir);

    const index = await readSessionIndex(dir);
    assert.equal(index?.files.includes("doomed-session.json"), false);
    assert.equal(
      index?.entries.some((entry) => entry.file === "doomed-session.json"),
      false,
    );
  });
});
