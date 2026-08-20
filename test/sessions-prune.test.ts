import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  fileExists,
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?prune_test=${cacheBuster}`)) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-prune-test-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

function messagesLogPath(homeDir: string, recordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(recordId)}.messages.ndjson`);
}

test("pruneSessions returns empty result when no closed sessions exist", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "open-session",
        acpSessionId: "open-session",
        agentCommand: "agent-a",
        cwd,
        closed: false,
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(result.pruned.length, 0);
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.dryRun, false);
  });
});

test("pruneSessions deletes closed session files and removes them from the index", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "closed-session",
        acpSessionId: "closed-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const filePath = sessionFilePath(homeDir, "closed-session");
    assert.ok(await fileExists(filePath));

    const result = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "closed-session");
    assert.ok(result.bytesFreed > 0);
    assert.equal(result.dryRun, false);
    assert.ok(!(await fileExists(filePath)));
  });
});

test("pruneSessions deletes message log sidecars with the closed session record", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "closed-with-log",
        acpSessionId: "closed-with-log",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const logPath = messagesLogPath(homeDir, "closed-with-log");
    await fs.writeFile(logPath, '{"User":{"id":"u1","content":[{"Text":"hi"}]}}\n', "utf8");
    await fs.writeFile(
      `${logPath}.stale`,
      '{"User":{"id":"stale","content":[{"Text":"old"}]}}\n',
      "utf8",
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.equal(result.pruned.length, 1);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "closed-with-log"))));
    assert.ok(!(await fileExists(logPath)));
    assert.ok(!(await fileExists(`${logPath}.stale`)));
  });
});

test("pruneSessions --dry-run does not delete files but returns correct count", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "dry-run-session",
        acpSessionId: "dry-run-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const filePath = sessionFilePath(homeDir, "dry-run-session");
    assert.ok(await fileExists(filePath));

    const result = await session.pruneSessions({ agentCommand: "agent-a", dryRun: true });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.dryRun, true);
    assert.ok(await fileExists(filePath));
  });
});

test("pruneSessions --before uses closedAt before falling back to lastUsedAt", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "old-session",
        acpSessionId: "old-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2025-06-01T00:00:00.000Z",
        lastUsedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "recent-session",
        acpSessionId: "recent-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-03-01T00:00:00.000Z",
        lastUsedAt: "2025-06-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      before: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "old-session");
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "old-session"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "recent-session")));
  });
});

test("pruneSessions --older-than prunes sessions beyond the day threshold", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    // Session with lastUsedAt far in the past
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "ancient-session",
        acpSessionId: "ancient-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2020-01-01T00:00:00.000Z",
        lastUsedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    // Session with lastUsedAt very recently (should not be pruned)
    const now = new Date().toISOString();
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "fresh-session",
        acpSessionId: "fresh-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: now,
        lastUsedAt: now,
      }),
    );

    // Prune sessions older than 1 day
    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      olderThanMs: 1 * 24 * 60 * 60 * 1000,
    });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "ancient-session");
    assert.ok(await fileExists(sessionFilePath(homeDir, "fresh-session")));
  });
});

test("pruneSessions scoped to agentCommand only prunes that agent's sessions", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "agent-a-session",
        acpSessionId: "agent-a-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "agent-b-session",
        acpSessionId: "agent-b-session",
        agentCommand: "agent-b",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "agent-a-session");
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "agent-a-session"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "agent-b-session")));
  });
});

test("pruneSessions scopes by stable agentName when command changes", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "stable-claude-session",
        acpSessionId: "stable-claude-session",
        agentName: "claude",
        agentCommand: "npx @old/claude-agent-acp",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "other-agent-session",
        acpSessionId: "other-agent-session",
        agentName: "codex",
        agentCommand: "npx @agentclientprotocol/codex-acp",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({
      agentCommand: "npx @new/claude-agent-acp",
      agentName: "claude",
    });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].acpxRecordId, "stable-claude-session");
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "stable-claude-session"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "other-agent-session")));
  });
});

test("pruneSessions --include-history deletes stream files", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "stream-session",
        acpSessionId: "stream-session",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const safeId = encodeURIComponent("stream-session");
    const streamFile = path.join(sessionsDir, `${safeId}.stream.ndjson`);
    const streamSegment = path.join(sessionsDir, `${safeId}.stream.0.ndjson`);
    const streamLock = path.join(sessionsDir, `${safeId}.stream.lock`);
    const neighborStreamFile = path.join(
      sessionsDir,
      `${encodeURIComponent("stream-session.stream-neighbor")}.stream.ndjson`,
    );
    await fs.writeFile(streamFile, "event-data\n", "utf8");
    await fs.writeFile(streamSegment, "segment-data\n", "utf8");
    await fs.writeFile(streamLock, "", "utf8");
    await fs.writeFile(neighborStreamFile, "neighbor-data\n", "utf8");

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      includeHistory: true,
    });
    assert.equal(result.pruned.length, 1);
    assert.ok(result.bytesFreed > 0);
    assert.ok(!(await fileExists(streamFile)));
    assert.ok(!(await fileExists(streamSegment)));
    assert.ok(!(await fileExists(streamLock)));
    assert.ok(await fileExists(neighborStreamFile));
  });
});

test("pruneSessions without agentCommand prunes all closed sessions across all agents", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "all-a",
        acpSessionId: "all-a",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "all-b",
        acpSessionId: "all-b",
        agentCommand: "agent-b",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "all-open",
        acpSessionId: "all-open",
        agentCommand: "agent-a",
        cwd,
        closed: false,
      }),
    );

    const result = await session.pruneSessions({});
    assert.equal(result.pruned.length, 2);
    const prunedIds = result.pruned.map((r) => r.acpxRecordId).toSorted();
    assert.deepEqual(prunedIds, ["all-a", "all-b"]);
    assert.ok(await fileExists(sessionFilePath(homeDir, "all-open")));
  });
});

// ─── brick://a62de399: template blueprints must survive prune ────────────────
// A blueprint is a CLOSED session by design, so it matched prune's only two
// criteria (closed + agent) and was deleted silently — taking every consumer of
// its slug with it. Real incident: the `telegram-personal-assistant` blueprint
// was pruned, and every `sessions new --from-template telegram-personal-assistant`
// then failed with "no template matches".

async function writeTemplateRecord(
  homeDir: string,
  cwd: string,
  overrides: { acpxRecordId: string; slug: string; enabled?: boolean; agentCommand?: string },
): Promise<void> {
  await writeSessionRecord(
    homeDir,
    makeSessionRecord({
      acpxRecordId: overrides.acpxRecordId,
      acpSessionId: overrides.acpxRecordId,
      agentCommand: overrides.agentCommand ?? "agent-a",
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:00:00.000Z",
      template: {
        enabled: overrides.enabled ?? true,
        slug: overrides.slug,
        version: 1,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    }),
  );
}

test("pruneSessions skips template-marked sessions and prunes plain closed ones", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeTemplateRecord(homeDir, cwd, {
      acpxRecordId: "blueprint",
      slug: "telegram-personal-assistant",
    });
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "plain-closed",
        acpSessionId: "plain-closed",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      ["plain-closed"],
    );
    assert.deepEqual(
      result.skippedTemplates.map((r) => r.acpxRecordId),
      ["blueprint"],
    );
    assert.equal(result.skippedTemplates[0].template?.slug, "telegram-personal-assistant");
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "plain-closed"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "blueprint")));
  });
});

test("pruneSessions skips a soft-retracted (enabled:false) template", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    // softRetractTemplateRecord keeps the block and only flips enabled:false, so
    // `templates rollback` can still reach this blueprint. Prune must respect the
    // block, not `enabled` — narrowing the guard to enabled===true fails here.
    await writeTemplateRecord(homeDir, cwd, {
      acpxRecordId: "retracted-blueprint",
      slug: "intaker",
      enabled: false,
    });

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.equal(result.pruned.length, 0);
    assert.deepEqual(
      result.skippedTemplates.map((r) => r.acpxRecordId),
      ["retracted-blueprint"],
    );
    assert.ok(await fileExists(sessionFilePath(homeDir, "retracted-blueprint")));
  });
});

test("pruneSessions deletes templates only with the explicit includeTemplates opt-in", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeTemplateRecord(homeDir, cwd, { acpxRecordId: "doomed", slug: "some-template" });

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      includeTemplates: true,
    });

    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      ["doomed"],
    );
    assert.equal(result.skippedTemplates.length, 0);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "doomed"))));
  });
});

test("pruneSessions dry-run reports templates as skipped, not as would-prune", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeTemplateRecord(homeDir, cwd, { acpxRecordId: "dry-blueprint", slug: "bp" });
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "dry-plain",
        acpSessionId: "dry-plain",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a", dryRun: true });

    assert.equal(result.dryRun, true);
    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      ["dry-plain"],
    );
    assert.deepEqual(
      result.skippedTemplates.map((r) => r.acpxRecordId),
      ["dry-blueprint"],
    );
    assert.ok(await fileExists(sessionFilePath(homeDir, "dry-blueprint")));
    assert.ok(await fileExists(sessionFilePath(homeDir, "dry-plain")));
  });
});

test("pruneSessions leaves the template's stream sidecars alone under --include-history", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    await writeTemplateRecord(homeDir, cwd, { acpxRecordId: "kept-bp", slug: "kept" });
    const streamPath = path.join(sessionDir, `${encodeURIComponent("kept-bp")}.stream.ndjson`);
    await fs.writeFile(streamPath, "event-data\n", "utf8");

    const result = await session.pruneSessions({ agentCommand: "agent-a", includeHistory: true });

    assert.equal(result.pruned.length, 0);
    assert.equal(result.skippedTemplates.length, 1);
    assert.ok(await fileExists(sessionFilePath(homeDir, "kept-bp")));
    assert.ok(await fileExists(streamPath));
  });
});
