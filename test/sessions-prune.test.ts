import assert from "node:assert/strict";
import { existsSync as fsExistsSync } from "node:fs";
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

/**
 * T-PERF-2's discriminating case. The stream-file lookup is an inverse index
 * built once over the directory listing (indexStreamFilesBySafeId), and the one
 * way to build it wrong is to key each filename on its FIRST `.stream.` only.
 *
 * The neighbour fixture above cannot catch that: `stream-session.stream-neighbor`
 * contains `.stream-`, not `.stream.`, so its first `.stream.` is already the
 * right one and a broken index looks correct. This id embeds a literal
 * `.stream.`, so a first-occurrence-only index files the file under `edge`
 * instead of `edge.stream.owner` and the stream SURVIVES a prune that reports
 * having deleted it. A positive control passes here trivially — only this
 * fixture discriminates.
 */
test("pruneSessions --include-history: a session id containing .stream. still owns its stream files", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");
    const trickyId = "edge.stream.owner";

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: trickyId,
        acpSessionId: trickyId,
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const safeId = encodeURIComponent(trickyId);
    // Guard the fixture itself: if encodeURIComponent ever escaped the dots the
    // id would no longer embed `.stream.` and this test would silently stop
    // testing anything.
    assert.ok(safeId.includes(".stream."), `fixture id lost its .stream. infix: ${safeId}`);
    const streamFile = path.join(sessionsDir, `${safeId}.stream.ndjson`);
    const streamLock = path.join(sessionsDir, `${safeId}.stream.lock`);
    await fs.writeFile(streamFile, "edge-event-data\n", "utf8");
    await fs.writeFile(streamLock, "", "utf8");

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      includeHistory: true,
    });

    assert.equal(result.pruned.length, 1);
    assert.ok(!(await fileExists(streamFile)), "stream file survived a prune that claimed it");
    assert.ok(!(await fileExists(streamLock)), "stream lock survived a prune that claimed it");
  });
});

/** The same id shape on the measurement half of the pair: a first-occurrence-only
 *  index under-reports stranding, which is the direction that lies to the
 *  operator about what a prune is about to leave behind. */
test("pruneSessions counts stranded streams for a session id containing .stream.", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");
    const trickyId = "edge.stream.owner";

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: trickyId,
        acpSessionId: trickyId,
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const safeId = encodeURIComponent(trickyId);
    await fs.writeFile(path.join(sessionsDir, `${safeId}.stream.ndjson`), "12345", "utf8");

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      dryRun: true,
      includeHistory: false,
    });

    assert.equal(result.strandedStreamFiles, 1);
    assert.equal(result.strandedStreamBytes, 5);
  });
});

/**
 * T5′ — the count precedes the ACT, not merely the line's presence.
 *
 * e6f0ff53 finding 4. The shipped T5 asserts three within-stdout index
 * comparisons, and a FAITHFUL M8 ("move the pre-flight print to after the
 * loop") satisfies all three byte-identically — the dd4cb0e8 TE measured it at
 * 213 tests, ZERO reds, having first verified the injection genuinely bit. Those
 * assertions pin that the line appears earlier in a string; they cannot pin that
 * it appears earlier than the DELETION, because the deletion leaves no mark in
 * stdout.
 *
 * This pins it against the filesystem instead: at the moment the hook runs, the
 * files must still be there, and a throw from the hook must leave them there.
 * Deterministic, no fault injection, and it uses only the abort path the
 * all-or-nothing id contract already depends on.
 */
test("T5': onBeforeDelete runs while the files still exist, and throwing leaves them all", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    for (const id of ["order-a", "order-b"]) {
      await writeSessionRecord(
        homeDir,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: id,
          agentCommand: "agent-a",
          cwd,
          closed: true,
          closedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await fs.writeFile(messagesLogPath(homeDir, id), `sidecar for ${id}\n`, "utf8");
    }

    const stdout: string[] = [];
    let existedAtCallbackTime: boolean[] = [];

    await assert.rejects(
      session.pruneSessions({
        agentCommand: "agent-a",
        onBeforeDelete: (plan) => {
          // The pre-flight line, as the CLI writes it.
          stdout.push(`Will prune ${plan.records.length} closed agent-a sessions.`);
          // The observation the string comparison cannot make: are they still here?
          existedAtCallbackTime = ["order-a", "order-b"].map((id) =>
            fsExistsSync(sessionFilePath(homeDir, id)),
          );
          throw new Error("abort after announcing");
        },
      }),
      /abort after announcing/,
    );

    assert.deepEqual(stdout, ["Will prune 2 closed agent-a sessions."]);
    assert.deepEqual(
      existedAtCallbackTime,
      [true, true],
      "the count was announced AFTER something had already been destroyed",
    );
    // And the throw destroyed nothing.
    for (const id of ["order-a", "order-b"]) {
      assert.ok(
        await fileExists(sessionFilePath(homeDir, id)),
        `${id} was deleted despite the abort`,
      );
      assert.ok(await fileExists(messagesLogPath(homeDir, id)));
    }
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

// ─── brick://bbaa1ef4: the guard must fail safe on a MALFORMED-but-PRESENT
// on-disk `template` block, not only a well-formed one ─────────────────────
// The parser (parseTemplateState, src/session/persistence/parse.ts) leniently
// drops a `template` block it cannot recognize — returns `undefined` — so
// isTemplateMarkedRecord's PARSED-value check (`record.template != null`) is
// blind to a present-but-malformed block from the very first read, and a
// plain checkpoint write (readPersistedLifecycle re-parses, drops the same
// way) then silently erases the block from disk entirely. Measured live
// against origin/dev@b8c79f2 (brick bbaa1ef4 probe/FINDINGS.md): a malformed
// block was NOT skipped by prune and a real scoped prune deleted it with no
// warning. The fix guards on the RAW on-disk `template` key instead, which is
// non-null whenever the block is present, well-formed or not.

async function patchRawTemplateField(
  homeDir: string,
  acpxRecordId: string,
  rawTemplate: unknown,
): Promise<void> {
  const filePath = sessionFilePath(homeDir, acpxRecordId);
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  raw.template = rawTemplate;
  await fs.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

test("pruneSessions skips a session whose on-disk template is present but non-object (malformed shape A)", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "malformed-a",
        acpSessionId: "malformed-a",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    // asRecord() (parse.ts) rejects a non-object `template` outright — the raw
    // block parses to undefined even though it is clearly present on disk.
    await patchRawTemplateField(homeDir, "malformed-a", "marked-as-template");

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      [],
    );
    assert.deepEqual(
      result.skippedTemplates.map((r) => r.acpxRecordId),
      ["malformed-a"],
    );
    assert.ok(await fileExists(sessionFilePath(homeDir, "malformed-a")));
  });
});

test("pruneSessions skips a session whose on-disk template object has no recognized/type-matching field (malformed shape B)", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "malformed-b",
        acpSessionId: "malformed-b",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    // Every field is either unrecognized or fails its type check (`enabled`
    // must be boolean, `created_at` must be string) — parseTemplateState's
    // per-field guards all fail, the parsed object stays `{}`, and it returns
    // undefined even though `raw.template` is a non-null object.
    await patchRawTemplateField(homeDir, "malformed-b", {
      enabled: "yes",
      created_at: 123,
      unknown_field: "x",
    });

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      [],
    );
    assert.deepEqual(
      result.skippedTemplates.map((r) => r.acpxRecordId),
      ["malformed-b"],
    );
    assert.ok(await fileExists(sessionFilePath(homeDir, "malformed-b")));
  });
});

test("pruneSessions still deletes a session with no template field at all (negative control, unaffected by the raw-key guard)", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "no-template",
        acpSessionId: "no-template",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      ["no-template"],
    );
    assert.equal(result.skippedTemplates.length, 0);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "no-template"))));
  });
});

// ─── brick://dd4cb0e8: scope selectors at the core ───────────────────────────
// The scope REQUIREMENT lives at the CLI (test/sessions-prune-scope.test.ts); the
// scope FILTERS live here, next to the template skip they extend.

test("pruneSessions sessionIds selects exactly the named sessions", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    for (const id of ["named-one", "named-two", "bystander"]) {
      await writeSessionRecord(
        homeDir,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: id,
          agentCommand: "agent-a",
          cwd,
          closed: true,
          closedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }

    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      sessionIds: ["named-one", "named-two"],
    });

    assert.deepEqual(result.pruned.map((r) => r.acpxRecordId).toSorted(), [
      "named-one",
      "named-two",
    ]);
    assert.ok(await fileExists(sessionFilePath(homeDir, "bystander")));
  });
});

test("pruneSessions cwd selects by EXACT equality, never by path prefix", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const target = path.join(homeDir, "workspace", "sweep");
    const sibling = path.join(homeDir, "workspace", "sweep-32002");

    for (const [id, dir] of [
      ["in-target", target],
      ["in-sibling", sibling],
    ] as const) {
      await writeSessionRecord(
        homeDir,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: id,
          agentCommand: "agent-a",
          cwd: dir,
          closed: true,
          closedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }

    const result = await session.pruneSessions({ agentCommand: "agent-a", cwd: target });

    assert.deepEqual(
      result.pruned.map((r) => r.acpxRecordId),
      ["in-target"],
    );
    assert.ok(
      await fileExists(sessionFilePath(homeDir, "in-sibling")),
      "a sibling whose path merely STARTS WITH the target must not be swept",
    );
  });
});

// The stale-index property, in the one direction a SELECTIVE predicate could
// over-delete. Direct analogue of the a62de399 template check's reason for running
// on the loaded record.
test("pruneSessions cwd is not out-run by a stale index entry", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const target = path.join(homeDir, "workspace", "target");
    const actual = path.join(homeDir, "workspace", "actual");
    const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "drifted",
        acpSessionId: "drifted",
        agentCommand: "agent-a",
        cwd: actual,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    // Hand-write an index whose entry claims the target cwd while the record on
    // disk says otherwise.
    const staleIndex = {
      schema: "acpx.session-index.v1",
      files: ["drifted.json"],
      entries: [
        {
          file: "drifted.json",
          acpxRecordId: "drifted",
          acpSessionId: "drifted",
          agentCommand: "agent-a",
          cwd: target,
          closed: true,
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(indexPath, `${JSON.stringify(staleIndex)}\n`, "utf8");

    const result = await session.pruneSessions({ agentCommand: "agent-a", cwd: target });

    assert.equal(result.pruned.length, 0, "the loaded record's cwd is the authority");
    assert.ok(await fileExists(sessionFilePath(homeDir, "drifted")));

    // Control: with entry and record agreeing, the same call DOES delete it — so
    // the assertion above is not passing because the harness selects nothing.
    const agreed = await session.pruneSessions({ agentCommand: "agent-a", cwd: actual });
    assert.deepEqual(
      agreed.pruned.map((r) => r.acpxRecordId),
      ["drifted"],
    );
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "drifted"))));
  });
});

// The a62de399 residual: sidecar survival for a protected blueprint was correct but
// asserted nowhere — the landed tests covered only .stream.ndjson. The sidecar is
// the transcript-index REBUILD source, so it is the dimension that matters most.
test("a protected blueprint keeps its messages sidecar through a prune", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeTemplateRecord(homeDir, cwd, { acpxRecordId: "bp-sidecar", slug: "bp" });
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "plain-sidecar",
        acpSessionId: "plain-sidecar",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await fs.mkdir(path.join(homeDir, ".acpx", "sessions"), { recursive: true });
    await fs.writeFile(messagesLogPath(homeDir, "bp-sidecar"), "blueprint messages\n", "utf8");
    await fs.writeFile(messagesLogPath(homeDir, "plain-sidecar"), "plain messages\n", "utf8");

    // Stated as a TRANSITION, not an absence: present before, present after.
    assert.ok(await fileExists(messagesLogPath(homeDir, "bp-sidecar")));
    assert.ok(await fileExists(messagesLogPath(homeDir, "plain-sidecar")));

    await session.pruneSessions({ agentCommand: "agent-a" });

    assert.ok(
      await fileExists(messagesLogPath(homeDir, "bp-sidecar")),
      "the protected blueprint's transcript rebuild source must survive",
    );
    // POSITIVE CONTROL, same run, same helper: a non-template sidecar went
    // present -> absent, so the instrument can see sidecars disappear.
    assert.ok(
      !(await fileExists(messagesLogPath(homeDir, "plain-sidecar"))),
      "positive control: an unprotected sidecar must have been deleted in the same run",
    );
  });
});

// M12: filtering templates on the INDEX ENTRY instead of the loaded record turns a
// missing projection into a deleted blueprint. The entry here carries no template
// projection at all while the record does.
test("a blueprint is skipped even when its index entry lacks template enrichment", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");

    await writeTemplateRecord(homeDir, cwd, { acpxRecordId: "unenriched-bp", slug: "bp" });

    const bareIndex = {
      schema: "acpx.session-index.v1",
      files: ["unenriched-bp.json"],
      entries: [
        {
          file: "unenriched-bp.json",
          acpxRecordId: "unenriched-bp",
          acpSessionId: "unenriched-bp",
          agentCommand: "agent-a",
          cwd,
          closed: true,
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(indexPath, `${JSON.stringify(bareIndex)}\n`, "utf8");

    const result = await session.pruneSessions({ agentCommand: "agent-a" });

    assert.equal(result.pruned.length, 0);
    assert.deepEqual(
      result.skippedTemplates.map((r) => r.acpxRecordId),
      ["unenriched-bp"],
    );
    assert.ok(await fileExists(sessionFilePath(homeDir, "unenriched-bp")));
  });
});

// ─── onBeforeDelete: the ordering guarantee, proved deterministically ────────
//
// The stronger form of "the count precedes the act": a callback that throws must
// abort with ZERO files deleted. This uses only the abort path the all-or-nothing
// id contract already depends on — no fault injection, so there is no injection
// that can silently fail to fire.
test("onBeforeDelete runs before the first unlink and a throw deletes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    for (const id of ["abort-one", "abort-two"]) {
      await writeSessionRecord(
        homeDir,
        makeSessionRecord({
          acpxRecordId: id,
          acpSessionId: id,
          agentCommand: "agent-a",
          cwd,
          closed: true,
          closedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }

    let sawRecords = 0;
    await assert.rejects(
      session.pruneSessions({
        agentCommand: "agent-a",
        onBeforeDelete: (plan) => {
          sawRecords = plan.records.length;
          throw new Error("abort");
        },
      }),
      /abort/,
    );

    assert.equal(sawRecords, 2, "the callback must see the full plan");
    assert.ok(await fileExists(sessionFilePath(homeDir, "abort-one")));
    assert.ok(await fileExists(sessionFilePath(homeDir, "abort-two")));

    // Control: the same call WITHOUT the throw deletes both — so "nothing was
    // deleted" above is the abort's doing, not a harness that deletes nothing.
    const control = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(control.pruned.length, 2);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "abort-one"))));
  });
});

// M15: moving the onBeforeDelete call BELOW the `if (options.dryRun)` early return
// is the obvious misreading of "before the delete loop", and it would exempt
// --dry-run from the id contract the CLI enforces in that callback.
test("onBeforeDelete runs on a dry run too", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "dry-hook",
        acpSessionId: "dry-hook",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    let calls = 0;
    let sawDryRun: boolean | undefined;
    const result = await session.pruneSessions({
      agentCommand: "agent-a",
      dryRun: true,
      onBeforeDelete: (plan) => {
        calls += 1;
        sawDryRun = plan.dryRun;
      },
    });

    assert.equal(calls, 1, "a preview that skips the hook cannot fail where the real run fails");
    assert.equal(sawDryRun, true);
    assert.equal(result.dryRun, true);
    assert.ok(await fileExists(sessionFilePath(homeDir, "dry-hook")));
  });
});

// ─── stranded stream accounting ──────────────────────────────────────────────
test("pruneSessions reports the stream files it strands, and none with includeHistory", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const seed = async (): Promise<string> => {
      await writeSessionRecord(
        homeDir,
        makeSessionRecord({
          acpxRecordId: "stranding",
          acpSessionId: "stranding",
          agentCommand: "agent-a",
          cwd,
          closed: true,
          closedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const streamPath = path.join(sessionDir, `${encodeURIComponent("stranding")}.stream.ndjson`);
      await fs.writeFile(streamPath, "x".repeat(512), "utf8");
      return streamPath;
    };

    const streamPath = await seed();
    const stranded = await session.pruneSessions({ agentCommand: "agent-a" });
    assert.equal(stranded.strandedStreamFiles, 1);
    assert.equal(stranded.strandedStreamBytes, 512);
    assert.ok(await fileExists(streamPath), "the stream is left behind, unreachable");

    await seed();
    const reclaimed = await session.pruneSessions({
      agentCommand: "agent-a",
      includeHistory: true,
    });
    assert.equal(reclaimed.strandedStreamFiles, 0);
    assert.equal(reclaimed.strandedStreamBytes, 0);
    assert.ok(!(await fileExists(streamPath)));
  });
});
