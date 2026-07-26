import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  isTemplateRecord,
  serializeSessionRecordForDisk,
  writeSessionRecord as flushSessionRecord,
} from "../src/session/persistence.js";
import {
  fileExists,
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);

test("SessionRecord allows optional closed and closedAt fields", () => {
  const record = makeSessionRecord({
    acpxRecordId: "type-check",
    acpSessionId: "type-check",
    agentCommand: "agent",
    cwd: "/tmp/type-check",
  });

  assert.equal(record.closed, false);
  assert.equal(record.closedAt, undefined);
});

test("SessionRecord allows optional favorite and favoritedAt fields", () => {
  const record = makeSessionRecord({
    acpxRecordId: "favorite-type-check",
    acpSessionId: "favorite-type-check",
    agentCommand: "agent",
    cwd: "/tmp/favorite-type-check",
    favorite: true,
    favoritedAt: "2026-05-21T10:00:00.000Z",
  });

  assert.equal(record.favorite, true);
  assert.equal(record.favoritedAt, "2026-05-21T10:00:00.000Z");
});

test("listSessions preserves favorite and favoritedAt", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "favorite-roundtrip",
        acpSessionId: "favorite-roundtrip",
        agentCommand: "agent-a",
        cwd,
        favorite: true,
        favoritedAt: "2026-05-21T10:30:00.000Z",
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "favorite-roundtrip");
    assert.ok(record);
    assert.equal(record.favorite, true);
    assert.equal(record.favoritedAt, "2026-05-21T10:30:00.000Z");

    const onDisk = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "favorite-roundtrip"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(onDisk.favorite, true);
    assert.equal(onDisk.favorited_at, "2026-05-21T10:30:00.000Z");
  });
});

test("listSessions omits favorite/favorited_at when unset (no schema noise)", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "no-favorite",
        acpSessionId: "no-favorite",
        agentCommand: "agent-a",
        cwd,
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "no-favorite");
    assert.ok(record);
    assert.equal(record.favorite, undefined);
    assert.equal(record.favoritedAt, undefined);

    const onDisk = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "no-favorite"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal("favorite" in onDisk, false);
    assert.equal("favorited_at" in onDisk, false);
  });
});

test("listSessions preserves acpx desired_mode_id", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "desired-mode",
        acpSessionId: "desired-mode",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          desired_mode_id: "plan",
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "desired-mode");
    assert.ok(record);
    assert.equal(record.acpx?.desired_mode_id, "plan");
  });
});

test("listSessions preserves acpx desired_config_options", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "desired-config-options",
        acpSessionId: "desired-config-options",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          desired_config_options: {
            reasoning_effort: "high",
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "desired-config-options");
    assert.ok(record);
    assert.deepEqual(record.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
  });
});

test("listSessions preserves acpx reset_on_next_ensure", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "reset-on-next-ensure",
        acpSessionId: "reset-on-next-ensure",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          reset_on_next_ensure: true,
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "reset-on-next-ensure");
    assert.ok(record);
    assert.equal(record.acpx?.reset_on_next_ensure, true);
  });
});

test("listSessions preserves acpx session_options", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-options",
        acpSessionId: "session-options",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            model: "sonnet",
            allowed_tools: ["Read", "Grep"],
            max_turns: 7,
            subscription: "sub1",
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-options");
    assert.ok(record);
    assert.deepEqual(record.acpx?.session_options, {
      model: "sonnet",
      allowed_tools: ["Read", "Grep"],
      max_turns: 7,
      subscription: "sub1",
    });
  });
});

test("listSessions preserves acpx session_options subscription_switch breadcrumb", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "sub-switch",
        acpSessionId: "sub-switch",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            subscription: "sub2",
            subscription_switch: {
              from: "sub1",
              to: "sub2",
              reason: "failover",
              at: "2026-06-04T12:00:00.000Z",
            },
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "sub-switch");
    assert.ok(record);
    // The breadcrumb must survive the disk write→read round-trip (regression:
    // the read-parser whitelist used to drop subscription_switch).
    assert.deepEqual(record.acpx?.session_options?.subscription_switch, {
      from: "sub1",
      to: "sub2",
      reason: "failover",
      at: "2026-06-04T12:00:00.000Z",
    });
    assert.equal(record.acpx?.session_options?.subscription, "sub2");
  });
});

test("listSessions drops a malformed subscription_switch (missing required fields)", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "sub-switch-bad",
        acpSessionId: "sub-switch-bad",
        agentCommand: "agent-a",
        cwd,
        // `to`/`reason`/`at` missing → must be dropped on read, not surfaced.
        acpx: { session_options: { subscription_switch: { from: "sub1" } } as never },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "sub-switch-bad");
    assert.ok(record);
    assert.equal(record.acpx?.session_options?.subscription_switch, undefined);
  });
});

test("listSessions preserves acpx session_options provisioning_warning breadcrumb", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "provisioning-warning",
        acpSessionId: "provisioning-warning",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            provisioning_warning: {
              at: "2026-06-13T12:00:00.000Z",
              profileId: "home1",
              authMode: "claude-home",
              adapter: "claude-pty",
              anchor: "/tmp/home1/.claude",
              message: "human-owned commands directory left unchanged",
            },
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "provisioning-warning");
    assert.ok(record);
    assert.deepEqual(record.acpx?.session_options?.provisioning_warning, {
      at: "2026-06-13T12:00:00.000Z",
      profileId: "home1",
      authMode: "claude-home",
      adapter: "claude-pty",
      anchor: "/tmp/home1/.claude",
      message: "human-owned commands directory left unchanged",
    });
  });
});

test("listSessions preserves acpx session_options system_prompt string and append", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-system-prompt-string",
        acpSessionId: "session-system-prompt-string",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            system_prompt: "you are an obsidian assistant",
          },
        },
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-system-prompt-append",
        acpSessionId: "session-system-prompt-append",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            system_prompt: { append: "always speak in spanish" },
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const stringRecord = sessions.find(
      (entry) => entry.acpxRecordId === "session-system-prompt-string",
    );
    const appendRecord = sessions.find(
      (entry) => entry.acpxRecordId === "session-system-prompt-append",
    );
    assert.ok(stringRecord);
    assert.ok(appendRecord);
    assert.equal(
      stringRecord.acpx?.session_options?.system_prompt,
      "you are an obsidian assistant",
    );
    assert.deepEqual(appendRecord.acpx?.session_options?.system_prompt, {
      append: "always speak in spanish",
    });
  });
});

test("listSessions ignores unsupported conversation message shapes", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });

    const malformed = makeSessionRecord({
      acpxRecordId: "malformed-shape",
      acpSessionId: "malformed-shape",
      agentCommand: "agent",
      cwd: path.join(homeDir, "workspace"),
    });

    (malformed as unknown as Record<string, unknown>).messages = [
      {
        kind: "user",
        id: "user_1",
        content: [{ type: "text", text: "invalid" }],
      },
    ];

    await fs.writeFile(
      path.join(sessionDir, "malformed-shape.json"),
      JSON.stringify(serializeSessionRecordForDisk(malformed), null, 2) + "\n",
      "utf8",
    );

    const session = await loadSessionModule();
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "malformed-shape"),
      false,
    );
  });
});

test("listSessions preserves lifecycle and conversation metadata", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-a",
        acpSessionId: "session-a",
        agentCommand: "agent-a",
        cwd,
        pid: 12345,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:01:00.000Z",
        lastAgentExitCode: null,
        lastAgentExitSignal: "SIGTERM",
        lastAgentExitAt: "2026-01-01T00:02:00.000Z",
        lastAgentDisconnectReason: "process_exit",
        lastAgentUnexpectedDuringPrompt: true,
        title: "My Thread",
        messages: [
          {
            User: {
              id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
              content: [
                { Text: "hello" },
                { Audio: { source: "UklGRg==", mime_type: "audio/wav" } },
              ],
            },
          },
          {
            Agent: {
              content: [{ Text: "world" }],
              tool_results: {},
            },
          },
        ],
        updated_at: "2026-01-01T00:02:00.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-a");
    assert.ok(record);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.lastPromptAt, "2026-01-01T00:01:00.000Z");
    assert.equal(record.lastAgentExitCode, null);
    assert.equal(record.lastAgentExitSignal, "SIGTERM");
    assert.equal(record.lastAgentExitAt, "2026-01-01T00:02:00.000Z");
    assert.equal(record.lastAgentDisconnectReason, "process_exit");
    assert.equal(record.lastAgentUnexpectedDuringPrompt, true);
    assert.equal(record.messages.length, 2);
    assert.deepEqual(record.messages[0], {
      User: {
        id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
        content: [{ Text: "hello" }, { Audio: { source: "UklGRg==", mime_type: "audio/wav" } }],
      },
    });
    assert.equal(record.title, "My Thread");
  });
});

test("listSessions preserves optional agentSessionId", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-runtime",
        acpSessionId: "session-runtime",
        agentSessionId: "provider-runtime-123",
        agentCommand: "agent-a",
        cwd,
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-runtime");
    assert.ok(record);
    assert.equal(record.agentSessionId, "provider-runtime-123");
  });
});

test("findSession and findSessionByDirectoryWalk resolve expected records", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const packagesDir = path.join(repoRoot, "packages");
    const nestedDir = path.join(packagesDir, "app");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-root",
        acpSessionId: "session-root",
        agentCommand: "agent-a",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-packages",
        acpSessionId: "session-packages",
        agentCommand: "agent-a",
        cwd: packagesDir,
      }),
    );

    const foundDefault = await session.findSession({
      agentCommand: "agent-a",
      cwd: packagesDir,
    });
    assert.equal(foundDefault?.acpxRecordId, "session-packages");

    const boundary = session.findGitRepositoryRoot(nestedDir);
    const walked = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary,
    });
    assert.equal(walked?.acpxRecordId, "session-packages");
  });
});

test("explicit global name resolution is agent-scoped, index-first, and fails closed", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwdA = path.join(homeDir, "repo-a");
    const cwdB = path.join(homeDir, "repo-b");
    const cwdOtherAgent = path.join(homeDir, "repo-other-agent");
    await fs.mkdir(cwdA, { recursive: true });
    await fs.mkdir(cwdB, { recursive: true });
    await fs.mkdir(cwdOtherAgent, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "global-a",
        acpSessionId: "global-a",
        agentName: "codex",
        agentCommand: "old-codex-command",
        cwd: cwdA,
        name: "deploy",
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "other-agent",
        acpSessionId: "other-agent",
        agentName: "claude",
        agentCommand: "claude-command",
        cwd: cwdOtherAgent,
        name: "deploy",
      }),
    );

    const unique = await session.resolveGlobalSessionByName({
      agentName: "codex",
      agentCommand: "new-codex-command",
      name: "deploy",
    });
    assert.equal(unique?.acpxRecordId, "global-a");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "global-b",
        acpSessionId: "global-b",
        agentName: "codex",
        agentCommand: "new-codex-command",
        cwd: cwdB,
        name: "deploy",
      }),
    );

    await assert.rejects(
      session.resolveGlobalSessionByName({
        agentName: "codex",
        agentCommand: "new-codex-command",
        name: "deploy",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ambiguous/i);
        assert.match(error.message, new RegExp(`cwd: ${cwdA.replaceAll("\\", "\\\\")}`));
        assert.match(error.message, /record ID: global-a/);
        assert.match(error.message, new RegExp(`cwd: ${cwdB.replaceAll("\\", "\\\\")}`));
        assert.match(error.message, /record ID: global-b/);
        assert.match(error.message, /--session-id <id>/);
        assert.match(error.message, /--session-url <url>/);
        return true;
      },
    );
  });
});

test("findSession routes by stable agentName when command changes", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const nestedDir = path.join(repoRoot, "src");
    const legacyDir = path.join(homeDir, "legacy");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "stable-agent-session",
        acpSessionId: "stable-agent-session",
        agentName: "claude",
        agentCommand: "npx @old/claude-agent-acp",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "legacy-command-session",
        acpSessionId: "legacy-command-session",
        agentCommand: "legacy-agent-command",
        cwd: legacyDir,
      }),
    );

    const found = await session.findSession({
      agentName: "claude",
      agentCommand: "npx @new/claude-agent-acp",
      cwd: repoRoot,
    });
    assert.equal(found?.acpxRecordId, "stable-agent-session");

    const walked = await session.findSessionByDirectoryWalk({
      agentName: "claude",
      agentCommand: "npx @new/claude-agent-acp",
      cwd: nestedDir,
      boundary: repoRoot,
    });
    assert.equal(walked?.acpxRecordId, "stable-agent-session");

    const listed = await session.listSessionsForAgent("npx @new/claude-agent-acp", "claude");
    assert.deepEqual(
      listed.map((record) => record.acpxRecordId),
      ["stable-agent-session"],
    );

    const legacyFallback = await session.findSession({
      agentName: "claude",
      agentCommand: "legacy-agent-command",
      cwd: legacyDir,
    });
    assert.equal(legacyFallback?.acpxRecordId, "legacy-command-session");

    const legacyMissAfterCommandChange = await session.findSession({
      agentName: "claude",
      agentCommand: "renamed-legacy-agent-command",
      cwd: legacyDir,
    });
    assert.equal(legacyMissAfterCommandChange, undefined);
  });
});

test("writeSessionRecord maintains an index and listSessions rebuilds it when missing", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "repo");
    const record = makeSessionRecord({
      acpxRecordId: "indexed-session",
      acpSessionId: "indexed-session",
      agentCommand: "agent-a",
      cwd,
    });

    const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");
    await writeSessionRecord(homeDir, record);
    assert.equal(await fileExists(indexPath), false);

    const initialSessions = await session.listSessions();
    assert.equal(
      initialSessions.some((entry) => entry.acpxRecordId === "indexed-session"),
      true,
    );
    assert.equal(await fileExists(indexPath), true);

    await fs.rm(indexPath, { force: true });
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "indexed-session"),
      true,
    );
    assert.equal(await fileExists(indexPath), true);
  });
});

test("closeSession soft-closes and terminates matching process", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    const sessionId = "live-session";
    const cwd = path.join(homeDir, "repo");
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: process.execPath,
        cwd,
        pid: child.pid,
      }),
    );

    const filePath = sessionFilePath(homeDir, sessionId);

    try {
      const closed = await session.closeSession(sessionId);
      assert.equal(closed.closed, true);
      assert.equal(typeof closed.closedAt, "string");
      assert.equal(closed.pid, undefined);
      assert.equal(await fileExists(filePath), true);

      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      assert.equal(stored.closed, true);
      assert.equal(typeof stored.closed_at, "string");

      const exited = await waitForExit(child.pid);
      assert.equal(exited, true);
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }
  });
});

test("normalizeQueueOwnerTtlMs applies default and edge-case normalization", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    assert.equal(session.DEFAULT_QUEUE_OWNER_TTL_MS, 900_000);
    assert.equal(session.normalizeQueueOwnerTtlMs(undefined), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(session.normalizeQueueOwnerTtlMs(0), 0);
    assert.equal(session.normalizeQueueOwnerTtlMs(-1), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(session.normalizeQueueOwnerTtlMs(Number.NaN), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.POSITIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.NEGATIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(session.normalizeQueueOwnerTtlMs(1.6), 2);
    assert.equal(session.normalizeQueueOwnerTtlMs(15_000), 15_000);
  });
});

test("isTemplateRecord is the single source of truth: true only when template.enabled === true", () => {
  // The centralized predicate the CLI template verbs and acpx-ui must agree on.
  assert.equal(
    isTemplateRecord({ template: { enabled: true, created_at: "2026-06-01T00:00:00.000Z" } }),
    true,
  );
  assert.equal(isTemplateRecord({ template: { enabled: false } }), false);
  assert.equal(isTemplateRecord({ template: {} }), false);
  assert.equal(isTemplateRecord({ template: undefined }), false);
  assert.equal(isTemplateRecord({}), false);
});

test("FW-16: agent-exit checkpoint flush preserves an externally-marked template and does not regress updated_at", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const id = "tmpl-live";
    const MARK_TS = "2026-06-14T17:23:36.000Z";
    const STALE_TS = "2026-06-14T17:19:23.000Z";

    // On-disk record as acpx-ui leaves it after "Save as template": closed + a top-level
    // `template` block + a post-mark updated_at. makeSessionRecord omits `template`, so
    // inject it onto the serialized on-disk record the way the acpx-ui PATCH does.
    const marked = serializeSessionRecordForDisk(
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: MARK_TS,
        updated_at: MARK_TS,
      }),
    );
    marked["template"] = { enabled: true, created_at: MARK_TS };
    await fs.mkdir(path.dirname(sessionFilePath(homeDir, id)), { recursive: true });
    await fs.writeFile(
      sessionFilePath(homeDir, id),
      `${JSON.stringify(marked, null, 2)}\n`,
      "utf8",
    );

    // The live agent's STALE in-memory record (predates the mark: no template, older
    // updated_at, still open). A graceful connection_close flushes it through the real
    // preserve-lifecycle write path.
    const stale = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: id,
      agentCommand: "agent-a",
      cwd,
      updated_at: STALE_TS,
    });
    await flushSessionRecord(stale);

    const onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      onDisk["template"],
      { enabled: true, created_at: MARK_TS },
      "the template marker must survive a stale agent-exit flush",
    );
    assert.equal(
      onDisk["updated_at"],
      MARK_TS,
      "updated_at must not regress below the on-disk mark",
    );
    assert.equal(onDisk["closed"], true, "existing closed/lifecycle read-preserve still holds");
  });
});

test("W13-01: template slug+version survive a plain (read-preserve) daemon write", async () => {
  // The single most important "don't forget": the FW-16 read-preserve path
  // re-parses the on-disk `template` block (via parseTemplateState) on EVERY
  // plain daemon write and re-adopts it. If parseTemplateState did not parse the
  // new slug/version fields, they would silently evaporate on the next
  // checkpoint. This proves the parse round-trip preserves them.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const id = "tmpl-slug-live";
    const MARK_TS = "2026-06-23T12:00:00.000Z";

    const marked = serializeSessionRecordForDisk(
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: MARK_TS,
        updated_at: MARK_TS,
      }),
    );
    marked["template"] = {
      enabled: true,
      created_at: MARK_TS,
      slug: "context-engineer",
      version: 3,
    };
    await fs.mkdir(path.dirname(sessionFilePath(homeDir, id)), { recursive: true });
    await fs.writeFile(
      sessionFilePath(homeDir, id),
      `${JSON.stringify(marked, null, 2)}\n`,
      "utf8",
    );

    // A stale in-memory record (no template) flushed through the real
    // preserve-lifecycle write path — the agent-exit checkpoint case.
    const stale = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: id,
      agentCommand: "agent-a",
      cwd,
      updated_at: "2026-06-23T11:00:00.000Z",
    });
    await flushSessionRecord(stale);

    const onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      onDisk["template"],
      { enabled: true, created_at: MARK_TS, slug: "context-engineer", version: 3 },
      "slug + version must survive the plain-write re-parse round-trip",
    );
  });
});

test("FW-16: a normal agent-exit flush still persists a non-template record (no regression)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const id = "plain-live";
    const OLD_TS = "2026-06-14T10:00:00.000Z";
    const NEW_TS = "2026-06-14T11:00:00.000Z";

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "agent-a",
        cwd,
        updated_at: OLD_TS,
      }),
    );

    // The normal case: the agent genuinely advanced the record (newer updated_at, more seq).
    const fresher = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: id,
      agentCommand: "agent-a",
      cwd,
      updated_at: NEW_TS,
      lastSeq: 3,
    });
    await flushSessionRecord(fresher);

    const onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal("template" in onDisk, false, "no spurious template marker is introduced");
    assert.equal(onDisk["updated_at"], NEW_TS, "a genuinely newer in-memory updated_at still wins");
    assert.equal(onDisk["last_seq"], 3, "record content still persists on a normal flush");
  });
});

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?session_test=${cacheBuster}`)) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-test-home-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

async function waitForExit(pid: number | undefined): Promise<boolean> {
  if (pid == null) {
    return true;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  return false;
}
