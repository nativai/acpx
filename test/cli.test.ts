import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InvalidArgumentError } from "commander";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import {
  formatPromptSessionBannerLine,
  parseAllowedTools,
  parseMaxTurns,
  parseTtlSeconds,
} from "../src/cli.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  cleanupOwnerArtifacts,
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
function readPackageVersionForTest(): string {
  const candidates = [
    fileURLToPath(new URL("../package.json", import.meta.url)),
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    path.join(process.cwd(), "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version;
      }
    } catch {
      // continue searching
    }
  }
  throw new Error("package.json version is missing");
}

const PACKAGE_VERSION = readPackageVersionForTest();
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const MOCK_AGENT_IGNORING_SIGTERM = `${MOCK_AGENT_COMMAND} --ignore-sigterm`;
const MOCK_CODEX_AGENT_WITH_RUNTIME_SESSION_ID = `${MOCK_AGENT_COMMAND} --codex-session-id codex-runtime-session`;
const MOCK_CLAUDE_AGENT_WITH_RUNTIME_SESSION_ID = `${MOCK_AGENT_COMMAND} --claude-session-id claude-runtime-session`;
const MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID = `${MOCK_AGENT_COMMAND} --supports-load-session --load-runtime-session-id loaded-runtime-session`;
const MOCK_AGENT_WITH_DISTINCT_CREATE_AND_LOAD_RUNTIME_SESSION_IDS =
  `${MOCK_AGENT_COMMAND} --runtime-session-id fresh-runtime-session ` +
  "--supports-load-session --load-runtime-session-id resumed-runtime-session";
const MOCK_AGENT_WITH_LOAD_FALLBACK = `${MOCK_AGENT_COMMAND} --supports-load-session --load-session-fails-on-empty`;
const MOCK_AGENT_WITH_LOAD_SESSION_NOT_FOUND = `${MOCK_AGENT_COMMAND} --supports-load-session --load-session-not-found`;
const MOCK_AGENT_WITH_LOAD_FALLBACK_AND_MODE_FAILURE = `${MOCK_AGENT_COMMAND} --supports-load-session --load-session-fails-on-empty --set-session-mode-fails`;
const MOCK_AGENT_WITH_FORK_SESSION = `${MOCK_AGENT_COMMAND} --supports-fork-session`;
const MOCK_AGENT_WITH_SET_MODE_INVALID_PARAMS = `${MOCK_AGENT_COMMAND} --set-session-mode-invalid-params`;
const MOCK_AGENT_WITH_SET_CONFIG_INVALID_PARAMS = `${MOCK_AGENT_COMMAND} --set-session-config-invalid-params`;

async function writeFakeClaudeAgentPackage(homeDir: string): Promise<string> {
  const packageRoot = path.join(homeDir, "fake-claude-agent-acp");
  const packageIndexPath = path.join(packageRoot, "dist", "index.js");
  const sdkPath = path.join(
    packageRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "sdk.mjs",
  );
  await fs.mkdir(path.dirname(packageIndexPath), { recursive: true });
  await fs.mkdir(path.dirname(sdkPath), { recursive: true });
  await fs.writeFile(
    packageIndexPath,
    `import ${JSON.stringify(pathToFileURL(MOCK_AGENT_PATH).href)};\n`,
    "utf8",
  );
  await fs.writeFile(
    sdkPath,
    `
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function cwdHash(cwd) {
  return cwd.replace(/\\//g, "-");
}

async function readSourceTranscript(configDir, sessionId, dir) {
  return await fs.readFile(
    path.join(configDir, "projects", cwdHash(dir), sessionId + ".jsonl"),
    "utf8",
  );
}

export async function forkSession(sessionId, options = {}) {
  const dir = options.dir;
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("missing destination dir");
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const newId = "durable-" + sessionId;
  const source = await readSourceTranscript(configDir, sessionId, dir);
  const destinationPath = path.join(configDir, "projects", cwdHash(dir), newId + ".jsonl");
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, source, "utf8");
  await fs.appendFile(
    path.join(configDir, "fork-sdk-calls.jsonl"),
    JSON.stringify({
      sessionId,
      dir,
      upToMessageId: options.upToMessageId ?? null,
      destinationPath,
    }) + "\\n",
    "utf8",
  );
  return { sessionId: newId };
}
`,
    "utf8",
  );

  return packageIndexPath;
}

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type ParsedAcpError = {
  code?: number;
  message?: string;
  data?: Record<string, unknown> & {
    acpxCode?: string;
    detailCode?: string;
    origin?: string;
    sessionId?: string;
  };
};

test("CLI --version prints package version", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["--version"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    assert.equal(result.stdout.trim(), PACKAGE_VERSION);
  });
});

test("CLI --version prints package version with top-level output flags", async () => {
  await withTempHome(async (homeDir) => {
    const before = await runCli(["--format", "quiet", "--version"], homeDir);
    assert.equal(before.code, 0, before.stderr);
    assert.equal(before.stderr.trim(), "");
    assert.equal(before.stdout.trim(), PACKAGE_VERSION);

    const after = await runCli(["--json-strict", "--version"], homeDir);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(after.stderr.trim(), "");
    assert.equal(after.stdout.trim(), PACKAGE_VERSION);
  });
});

test("exec treats --version after end-of-options as prompt text", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "--format", "quiet", "exec", "--", "--version"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /unrecognized prompt: --version/);
    assert.notEqual(result.stdout.trim(), PACKAGE_VERSION);
  });
});

test("config commands accept command-local --format json", async () => {
  await withTempHome(async (homeDir) => {
    const show = await runCli(["config", "show", "--format", "json"], homeDir);
    assert.equal(show.code, 0, show.stderr);
    const showPayload = JSON.parse(show.stdout.trim()) as Record<string, unknown>;
    assert.equal(showPayload.defaultAgent, "codex");

    const init = await runCli(["config", "init", "--format", "json"], homeDir);
    assert.equal(init.code, 0, init.stderr);
    const initPayload = JSON.parse(init.stdout.trim()) as Record<string, unknown>;
    assert.equal(initPayload.created, true);
    assert.equal(typeof initPayload.path, "string");
  });
});

test(
  "CLI exits cleanly when stdout pipe closes early",
  { skip: process.platform === "win32" },
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });

      const result = await runShell(
        '"$NODE" "$CLI_PATH" --cwd "$WORK" --approve-all --agent "$MOCK_AGENT" exec "echo pipe-ok" | grep -q pipe-ok',
        {
          HOME: homeDir,
          NODE: process.execPath,
          CLI_PATH,
          WORK: cwd,
          MOCK_AGENT: MOCK_AGENT_COMMAND,
        },
      );

      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error'/);
    });
  },
);

function parseSingleAcpErrorLine(stdout: string): ParsedAcpError {
  const payload = JSON.parse(stdout.trim()) as {
    jsonrpc?: string;
    error?: ParsedAcpError;
  };
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(typeof payload.error, "object");
  return payload.error ?? {};
}

function parseJsonRpcLines(stdout: string): Array<Record<string, unknown>> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert(lines.length > 0, "expected at least one stdout line");
  return lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.jsonrpc, "2.0");
    return parsed;
  });
}

test("parseTtlSeconds parses and rounds valid numeric values", () => {
  assert.equal(parseTtlSeconds("30"), 30_000);
  assert.equal(parseTtlSeconds("0"), 0);
  assert.equal(parseTtlSeconds("1.49"), 1_490);
});

test("parseTtlSeconds rejects non-numeric values", () => {
  assert.throws(() => parseTtlSeconds("abc"), InvalidArgumentError);
});

test("parseTtlSeconds rejects negative values", () => {
  assert.throws(() => parseTtlSeconds("-1"), InvalidArgumentError);
});

test("parseAllowedTools parses empty and comma-separated values", () => {
  assert.deepEqual(parseAllowedTools(""), []);
  assert.deepEqual(parseAllowedTools("Read,Grep, Glob"), ["Read", "Grep", "Glob"]);
});

test("parseAllowedTools rejects empty entries", () => {
  assert.throws(() => parseAllowedTools("Read,,Grep"), InvalidArgumentError);
});

test("parseMaxTurns accepts positive integers and rejects invalid values", () => {
  assert.equal(parseMaxTurns("3"), 3);
  assert.throws(() => parseMaxTurns("0"), InvalidArgumentError);
  assert.throws(() => parseMaxTurns("1.5"), InvalidArgumentError);
});

test("formatPromptSessionBannerLine prints single-line prompt banner for matching cwd", () => {
  const record = makeSessionRecord({
    acpxRecordId: "abc123",
    acpSessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  });

  const line = formatPromptSessionBannerLine(record, "/home/user/project");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project · agent needs reconnect",
  );
});

test("formatPromptSessionBannerLine includes routed-from path when cwd differs", () => {
  const record = makeSessionRecord({
    acpxRecordId: "abc123",
    acpSessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  });

  const line = formatPromptSessionBannerLine(record, "/home/user/project/src/auth");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project (routed from ./src/auth) · agent needs reconnect",
  );
});

test("CLI resolves unknown subcommand names as raw agent commands", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const session = makeSessionRecord({
      acpxRecordId: "custom-session",
      acpSessionId: "custom-session",
      agentCommand: "custom-agent",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });
    await writeSessionRecord(homeDir, session);

    const result = await runCli(
      ["--cwd", cwd, "--format", "quiet", "custom-agent", "sessions", "--local"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /custom-session/);
  });
});

test("CLI resolves unknown raw agent commands after newer global flags", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const session = makeSessionRecord({
      acpxRecordId: "custom-session",
      acpSessionId: "custom-session",
      agentCommand: "custom-agent",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });
    await writeSessionRecord(homeDir, session);

    const flagCases = [
      ["--system-prompt", "be precise"],
      ["--append-system-prompt", "be concise"],
      ["--prompt-retries", "1"],
      ["--no-terminal"],
    ];

    for (const flags of flagCases) {
      const result = await runCli(
        ["--cwd", cwd, "--format", "quiet", ...flags, "custom-agent", "sessions"],
        homeDir,
      );

      assert.equal(result.code, 0, `${flags.join(" ")}\n${result.stderr}`);
      assert.match(result.stdout, /custom-session/, flags.join(" "));
    }
  });
});

test("global passthrough flags are present in help output", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["--help"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /--model <id>/);
    assert.match(result.stdout, /--allowed-tools <list>/);
    assert.match(result.stdout, /--max-turns <count>/);
    assert.match(result.stdout, /text, json, quiet/);
    assert.match(result.stdout, /--suppress-reads/);
    assert.match(result.stdout, /--no-terminal/);
  });
});

test("CLI ignores npm-run delimiter before forwarded arguments", async () => {
  await withTempHome(async (homeDir) => {
    const env = {
      npm_lifecycle_event: "dev",
      npm_lifecycle_script: "tsx src/cli.ts",
    };

    const rootHelp = await runCli(["--", "--help"], homeDir, { env });
    assert.equal(rootHelp.code, 0, rootHelp.stderr);
    assert.match(rootHelp.stdout, /Usage: acpx/);

    const importHelp = await runCli(["--", "codex", "sessions", "import", "--help"], homeDir, {
      env,
    });
    assert.equal(importHelp.code, 0, importHelp.stderr);
    assert.match(importHelp.stdout, /Import a portable session archive/);
    assert.match(importHelp.stdout, /archive-path/);
  });
});

test("sessions new command is present in help output", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["sessions", "--help"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\bnew\b/);
    assert.match(result.stdout, /\bensure\b/);
    assert.match(result.stdout, /\bread\b/);
    assert.match(result.stdout, /migrate-messages/);
    assert.match(result.stdout, /\bprune\b/);

    const newHelp = await runCli(["sessions", "new", "--help"], homeDir);
    assert.equal(newHelp.code, 0, newHelp.stderr);
    assert.match(newHelp.stdout, /--name <name>/);
    assert.match(newHelp.stdout, /--resume-session <id>/);

    const ensureHelp = await runCli(["sessions", "ensure", "--help"], homeDir);
    assert.equal(ensureHelp.code, 0, ensureHelp.stderr);
    assert.match(ensureHelp.stdout, /--name <name>/);

    const readHelp = await runCli(["sessions", "read", "--help"], homeDir);
    assert.equal(readHelp.code, 0, readHelp.stderr);
    assert.match(readHelp.stdout, /--tail <count>/);
    assert.match(ensureHelp.stdout, /--resume-session <id>/);

    const pruneHelp = await runCli(["sessions", "prune", "--help"], homeDir);
    assert.equal(pruneHelp.code, 0, pruneHelp.stderr);
    assert.match(pruneHelp.stdout, /--dry-run/);
    assert.match(pruneHelp.stdout, /--include-history/);
  });
});

test("flow run command is present in help output", async () => {
  await withTempHome(async (homeDir) => {
    const flowHelp = await runCli(["flow", "--help"], homeDir);
    assert.equal(flowHelp.code, 0, flowHelp.stderr);
    assert.match(flowHelp.stdout, /\brun\b/);

    const runHelp = await runCli(["flow", "run", "--help"], homeDir);
    assert.equal(runHelp.code, 0, runHelp.stderr);
    assert.match(runHelp.stdout, /--input-json <json>/);
    assert.match(runHelp.stdout, /--input-file <path>/);
    assert.match(runHelp.stdout, /--default-agent <name>/);
  });
});

test("sessions new --resume-session loads ACP session and stores resumed ids", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_DISTINCT_CREATE_AND_LOAD_RUNTIME_SESSION_IDS,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const resumeSessionId = "cs_resume123";
    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--resume-session",
        resumeSessionId,
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      action?: unknown;
      created?: unknown;
      acpxRecordId?: unknown;
      acpxSessionId?: unknown;
      agentSessionId?: unknown;
    };
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, true);
    assert.equal(payload.acpxRecordId, resumeSessionId);
    assert.equal(payload.acpxSessionId, resumeSessionId);
    assert.equal(payload.agentSessionId, "resumed-runtime-session");

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(resumeSessionId)}.json`,
    );
    const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
      acp_session_id?: unknown;
      agent_session_id?: unknown;
    };
    assert.equal(storedRecord.acp_session_id, resumeSessionId);
    assert.equal(storedRecord.agent_session_id, "resumed-runtime-session");
  });
});

test("sessions new --resume-session fails when agent does not support session reuse", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "codex", "sessions", "new", "--resume-session", "cs_unsupported"],
      homeDir,
    );

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /does not support session\/resume or session\/load/i);
  });
});

test("sessions new --resume-session surfaces not-found loadSession errors without fallback", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_LOAD_SESSION_NOT_FOUND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const resumeSessionId = "cs_missing";
    const result = await runCli(
      ["--cwd", cwd, "codex", "sessions", "new", "--resume-session", resumeSessionId],
      homeDir,
    );

    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /Failed to resume ACP session cs_missing: Resource not found/);

    const sessionsDir = path.join(homeDir, ".acpx", "sessions");
    const entries = await fs.readdir(sessionsDir).catch(() => [] as string[]);
    assert.equal(entries.includes(`${encodeURIComponent(resumeSessionId)}.json`), false);
  });
});

test("sessions copy creates a full same-agent copy with lineage and metadata", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    const sub1Dir = path.join(homeDir, ".acpx", "subscriptions", "sub1");
    await fs.mkdir(sub1Dir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "subscriptions", "registry.json"),
      `${JSON.stringify(
        {
          profiles: [
            {
              id: "sub1",
              label: "Sub One",
              authMode: "subscription",
              account: "acct-sub1",
              credentialSource: sub1Dir,
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_FORK_SESSION,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const messages: SessionRecord["messages"] = [
      { User: { id: "user-1", content: [{ Text: "remember alpha" }] } },
      { Agent: { content: [{ Text: "alpha noted" }], tool_results: {} } },
    ];
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-copy",
      acpSessionId: "source-acp-copy",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
      lastSeq: messages.length,
      messages,
      acpx: {
        session_options: {
          subscription: "sub1",
          allowed_tools: ["Read", "Grep"],
          max_turns: 3,
          system_prompt: "stay on task",
        },
        desired_config_options: {
          effort: "high",
          custom: "keep-me",
        },
      },
    });

    const result = await runCli(
      [
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-copy",
        "--name",
        "copied",
        "--metadata",
        "task_folder=/wisdom/task",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      action?: unknown;
      acpxRecordId?: unknown;
      acpxSessionId?: unknown;
      agentSessionId?: unknown;
      sourceSessionId?: unknown;
      forkedAtMessageIndex?: unknown;
    };
    assert.equal(payload.action, "session_copied");
    assert.equal(payload.sourceSessionId, "source-copy");
    assert.equal(payload.forkedAtMessageIndex, messages.length);
    assert.equal(typeof payload.acpxRecordId, "string");
    assert.notEqual(payload.acpxSessionId, payload.agentSessionId);
    assert.match(String(payload.acpxSessionId), /^[0-9a-f-]{36}$/);
    assert.match(String(payload.agentSessionId), /^forked-runtime-/);

    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, String(payload.acpxRecordId)), "utf8"),
    ) as {
      acp_session_id?: unknown;
      agent_session_id?: unknown;
      agent_command?: unknown;
      cwd?: unknown;
      name?: unknown;
      last_seq?: unknown;
      forked_from_session_id?: unknown;
      forked_at_message_index?: unknown;
      metadata?: Record<string, unknown>;
      messages?: unknown[];
      acpx?: {
        session_options?: {
          subscription?: unknown;
          allowed_tools?: unknown;
          max_turns?: unknown;
          system_prompt?: unknown;
        };
        desired_config_options?: Record<string, unknown>;
      };
    };
    assert.equal(stored.acp_session_id, payload.acpxSessionId);
    assert.equal(stored.agent_session_id, payload.agentSessionId);
    assert.equal(stored.agent_command, MOCK_AGENT_WITH_FORK_SESSION);
    assert.equal(stored.cwd, cwd);
    assert.equal(stored.name, "copied");
    assert.equal(stored.last_seq, 0);
    assert.equal(stored.forked_from_session_id, "source-copy");
    assert.equal(stored.forked_at_message_index, messages.length);
    assert.equal(stored.metadata?.task_folder, "/wisdom/task");
    assert.deepEqual(stored.messages, messages);
    assert.equal(stored.acpx?.session_options?.subscription, "sub1");
    assert.deepEqual(stored.acpx?.session_options?.allowed_tools, ["Read", "Grep"]);
    assert.equal(stored.acpx?.session_options?.max_turns, 3);
    assert.equal(stored.acpx?.session_options?.system_prompt, "stay on task");
    assert.equal(stored.acpx?.desired_config_options?.effort, "high");
    assert.equal(stored.acpx?.desired_config_options?.custom, "keep-me");
  });
});

test("sessions copy --at-index 0 creates an empty Claude copy with lineage", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const claudeCommand = `${MOCK_AGENT_COMMAND} --claude-agent-acp --supports-fork-session`;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            claude: {
              command: claudeCommand,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-claude-zero",
      acpSessionId: "source-acp-claude-zero",
      agentCommand: claudeCommand,
      cwd,
      messages: [
        { User: { id: "user-1", content: [{ Text: "first" }] } },
        { Agent: { content: [{ Text: "second" }], tool_results: {} } },
      ],
      lastSeq: 2,
    });

    const result = await runCli(
      [
        "--format",
        "json",
        "claude",
        "sessions",
        "copy",
        "--from",
        "source-claude-zero",
        "--at-index",
        "0",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId?: unknown;
      forkedAtMessageIndex?: unknown;
    };
    assert.equal(payload.forkedAtMessageIndex, 0);
    assert.equal(typeof payload.acpxRecordId, "string");

    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, String(payload.acpxRecordId)), "utf8"),
    ) as {
      forked_from_session_id?: unknown;
      forked_at_message_index?: unknown;
      messages?: unknown[];
    };
    assert.equal(stored.forked_from_session_id, "source-claude-zero");
    assert.equal(stored.forked_at_message_index, 0);
    assert.deepEqual(stored.messages, []);
  });
});

test("sessions copy --at-index --ephemeral truncates messages and stamps byway metadata", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_FORK_SESSION,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const messages: SessionRecord["messages"] = [
      { User: { id: "user-1", content: [{ Text: "first" }] } },
      { Agent: { content: [{ Text: "second" }], tool_results: {} } },
      { User: { id: "user-2", content: [{ Text: "third" }] } },
    ];
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-truncate",
      acpSessionId: "source-acp-truncate",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
      lastSeq: messages.length,
      messages,
    });

    const result = await runCli(
      [
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-truncate",
        "--at-index",
        "1",
        "--ephemeral",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId?: unknown;
      ephemeral?: unknown;
      forkedAtMessageIndex?: unknown;
    };
    assert.equal(payload.ephemeral, true);
    assert.equal(payload.forkedAtMessageIndex, 1);
    assert.equal(typeof payload.acpxRecordId, "string");

    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, String(payload.acpxRecordId)), "utf8"),
    ) as {
      name?: unknown;
      kind?: unknown;
      last_seq?: unknown;
      forked_from_session_id?: unknown;
      forked_at_message_index?: unknown;
      metadata?: Record<string, unknown>;
      messages?: unknown[];
    };
    assert.equal(stored.name, "source (fork)");
    assert.equal(stored.kind, "session");
    assert.equal(stored.last_seq, 0);
    assert.equal(stored.forked_from_session_id, "source-truncate");
    assert.equal(stored.forked_at_message_index, 1);
    assert.equal(stored.metadata?.byway, "1");
    assert.equal(stored.metadata?.byway_parent, "source-truncate");
    assert.equal(stored.metadata?.byway_at, "1");
    assert.deepEqual(stored.messages, messages.slice(0, 1));
  });
});

test("sessions copy rejects Claude --at-index when no transcript UUID can be resolved", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const claudeCommand = `${MOCK_AGENT_COMMAND} --claude-agent-acp --supports-fork-session`;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            claude: {
              command: claudeCommand,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-claude-no-transcript",
      acpSessionId: "source-acp-claude-no-transcript",
      agentCommand: claudeCommand,
      cwd,
      messages: [{ User: { id: "user-1", content: [{ Text: "hello" }] } }],
      lastSeq: 1,
    });

    const result = await runCli(
      ["claude", "sessions", "copy", "--from", "source-claude-no-transcript", "--at-index", "1"],
      homeDir,
    );

    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr,
      /Cannot copy Claude session at --at-index 1: no Claude transcript UUID could be resolved/,
    );
  });
});

test("sessions copy resolves Claude --at-index from source cwd and forwards copied options", async () => {
  await withTempHome(async (homeDir) => {
    const sourceCwd = path.join(homeDir, "source-workspace");
    const destinationCwd = path.join(homeDir, "destination-workspace");
    const sourceAcpSessionId = "source-acp-claude-transcript";
    const packageIndexPath = await writeFakeClaudeAgentPackage(homeDir);
    const expectedForkMeta = {
      claudeCode: {
        options: {
          allowedTools: ["Read"],
          maxTurns: 2,
          resumeSessionAt: "assistant-uuid",
        },
      },
      systemPrompt: "copy prompt",
    };
    const claudeCommand = `node ${JSON.stringify(
      packageIndexPath,
    )} --claude-agent-acp --supports-fork-session --expect-fork-meta-json ${JSON.stringify(
      JSON.stringify(expectedForkMeta),
    )}`;
    await fs.mkdir(sourceCwd, { recursive: true });
    await fs.mkdir(destinationCwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            claude: {
              command: claudeCommand,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const transcriptPath = transcriptJsonlPath(
      path.join(homeDir, ".claude"),
      sourceCwd,
      sourceAcpSessionId,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-uuid",
          message: { content: [{ type: "text", text: "remember source cwd" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-uuid",
          message: { content: [{ type: "text", text: "noted" }] },
        }),
      ].join("\n"),
      "utf8",
    );

    const messages: SessionRecord["messages"] = [
      { User: { id: "user-1", content: [{ Text: "remember source cwd" }] } },
      { Agent: { content: [{ Text: "noted" }], tool_results: {} } },
    ];
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-claude-transcript",
      acpSessionId: sourceAcpSessionId,
      agentCommand: claudeCommand,
      cwd: sourceCwd,
      messages,
      lastSeq: messages.length,
      acpx: {
        session_options: {
          allowed_tools: ["Read"],
          max_turns: 2,
          system_prompt: "copy prompt",
        },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        destinationCwd,
        "--format",
        "json",
        "claude",
        "sessions",
        "copy",
        "--from",
        "source-claude-transcript",
        "--at-index",
        "2",
      ],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId?: unknown;
      forkedAtMessageIndex?: unknown;
    };
    assert.equal(payload.forkedAtMessageIndex, 2);
    assert.equal(typeof payload.acpxRecordId, "string");

    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, String(payload.acpxRecordId)), "utf8"),
    ) as {
      cwd?: unknown;
      forked_from_session_id?: unknown;
      forked_at_message_index?: unknown;
      messages?: unknown[];
    };
    assert.equal(stored.cwd, destinationCwd);
    assert.equal(stored.forked_from_session_id, "source-claude-transcript");
    assert.equal(stored.forked_at_message_index, 2);
    assert.deepEqual(stored.messages, messages);

    const callLog = await fs.readFile(
      path.join(homeDir, ".claude", "fork-sdk-calls.jsonl"),
      "utf8",
    );
    const call = JSON.parse(callLog.trim()) as {
      sessionId?: unknown;
      dir?: unknown;
      upToMessageId?: unknown;
    };
    assert.equal(call.sessionId, sourceAcpSessionId);
    assert.equal(call.dir, destinationCwd);
    assert.equal(call.upToMessageId, "assistant-uuid");
    await assert.rejects(
      fs.access(
        transcriptJsonlPath(path.join(homeDir, ".claude"), destinationCwd, sourceAcpSessionId),
      ),
      { code: "ENOENT" },
    );
  });
});

test("sessions copy materializes cross-cwd Claude forks in the destination project path", async () => {
  await withTempHome(async (homeDir) => {
    const sourceCwd = path.join(homeDir, "source-workspace");
    const destinationCwd = path.join(homeDir, "destination-workspace");
    const packageIndexPath = await writeFakeClaudeAgentPackage(homeDir);
    const configDir = path.join(homeDir, ".claude");
    const sourceAcpSessionId = "source-acp-cross-cwd";
    const marker = "MARKER-PHRASE-CROSS-CWD";
    const sourceTranscript = [
      JSON.stringify({
        type: "user",
        uuid: "cross-user-uuid",
        message: { content: [{ type: "text", text: "remember CROSS_CWD_SECRET=RUBY" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "cross-assistant-uuid",
        message: { content: [{ type: "text", text: `tool result: ${marker}` }] },
      }),
    ].join("\n");
    const claudeCommand = `node ${JSON.stringify(packageIndexPath)} --claude-agent-acp --supports-fork-session`;

    await fs.mkdir(sourceCwd, { recursive: true });
    await fs.mkdir(destinationCwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            claude: {
              command: claudeCommand,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sourceTranscriptPath = transcriptJsonlPath(configDir, sourceCwd, sourceAcpSessionId);
    await fs.mkdir(path.dirname(sourceTranscriptPath), { recursive: true });
    await fs.writeFile(sourceTranscriptPath, sourceTranscript, "utf8");

    const messages: SessionRecord["messages"] = [
      { User: { id: "user-1", content: [{ Text: "remember CROSS_CWD_SECRET=RUBY" }] } },
      { Agent: { content: [{ Text: `tool result: ${marker}` }], tool_results: {} } },
    ];
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-claude-cross-cwd",
      acpSessionId: sourceAcpSessionId,
      agentCommand: claudeCommand,
      cwd: sourceCwd,
      messages,
      lastSeq: messages.length,
    });

    const result = await runCli(
      [
        "--cwd",
        destinationCwd,
        "--format",
        "json",
        "claude",
        "sessions",
        "copy",
        "--from",
        "source-claude-cross-cwd",
        "--name",
        "cross-cwd-copy",
      ],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      acpxRecordId?: unknown;
      acpxSessionId?: unknown;
      agentSessionId?: unknown;
      forkedAtMessageIndex?: unknown;
    };
    assert.equal(payload.forkedAtMessageIndex, messages.length);
    assert.equal(payload.acpxSessionId, `durable-${sourceAcpSessionId}`);
    assert.equal(payload.agentSessionId, `durable-${sourceAcpSessionId}`);
    assert.equal(typeof payload.acpxRecordId, "string");

    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, String(payload.acpxRecordId)), "utf8"),
    ) as {
      acp_session_id?: unknown;
      agent_session_id?: unknown;
      cwd?: unknown;
      forked_from_session_id?: unknown;
      forked_at_message_index?: unknown;
      messages?: unknown[];
    };
    assert.equal(stored.acp_session_id, `durable-${sourceAcpSessionId}`);
    assert.equal(stored.agent_session_id, `durable-${sourceAcpSessionId}`);
    assert.equal(stored.cwd, destinationCwd);
    assert.equal(stored.forked_from_session_id, "source-claude-cross-cwd");
    assert.equal(stored.forked_at_message_index, messages.length);
    assert.deepEqual(stored.messages, messages);

    const callLog = await fs.readFile(path.join(configDir, "fork-sdk-calls.jsonl"), "utf8");
    const call = JSON.parse(callLog.trim()) as {
      sessionId?: unknown;
      dir?: unknown;
      upToMessageId?: unknown;
    };
    assert.equal(call.sessionId, sourceAcpSessionId);
    assert.equal(call.dir, destinationCwd);
    assert.equal(call.upToMessageId, null);

    const destinationTranscriptPath = transcriptJsonlPath(
      configDir,
      destinationCwd,
      `durable-${sourceAcpSessionId}`,
    );
    const destinationTranscript = await fs.readFile(destinationTranscriptPath, "utf8");
    assert.equal(destinationTranscript, sourceTranscript);
    assert.match(destinationTranscript, new RegExp(marker));
    assert.equal(await fs.readFile(sourceTranscriptPath, "utf8"), sourceTranscript);
    await assert.rejects(
      fs.access(transcriptJsonlPath(configDir, destinationCwd, sourceAcpSessionId)),
      {
        code: "ENOENT",
      },
    );
    await assert.rejects(
      fs.access(transcriptJsonlPath(configDir, sourceCwd, `durable-${sourceAcpSessionId}`)),
      { code: "ENOENT" },
    );
  });
});

test("sessions copy rejects explicit agent type mismatch", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_FORK_SESSION,
            },
            claude: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-lock",
      acpSessionId: "source-acp-lock",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
    });

    const result = await runCli(["claude", "sessions", "copy", "--from", "source-lock"], homeDir);

    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr,
      /sessions copy preserves the source agent type \(codex\); cannot copy as claude/,
    );
  });
});

test("sessions copy rejects adapters without fork capability", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-no-fork",
      acpSessionId: "source-acp-no-fork",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
    });

    const result = await runCli(["codex", "sessions", "copy", "--from", "source-no-fork"], homeDir);

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /does not advertise sessionCapabilities\.fork/);
  });
});

test("sessions copy Codex --at-index forwards forkAtMessageIndex to the agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    // Use a mock agent that supports fork and expects the acpx forkAtMessageIndex meta
    const CODEX_AGENT_WITH_FORK = `${MOCK_AGENT_WITH_FORK_SESSION} --expect-fork-meta-json ${JSON.stringify(
      JSON.stringify({ acpx: { forkAtMessageIndex: 1 } }),
    )}`;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: CODEX_AGENT_WITH_FORK,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-codex-at-index",
      acpSessionId: "source-acp-codex-at-index",
      agentCommand: CODEX_AGENT_WITH_FORK,
      cwd,
      messages: [{ User: { id: "user-1", content: [{ Text: "hello" }] } }],
      lastSeq: 1,
    });

    const result = await runCli(
      [
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-codex-at-index",
        "--at-index",
        "1",
      ],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      forkedAtMessageIndex?: unknown;
      acpxRecordId?: unknown;
    };
    assert.equal(payload.forkedAtMessageIndex, 1);
    assert.equal(typeof payload.acpxRecordId, "string");
  });
});

test("sessions copy rejects subagent source records", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_FORK_SESSION,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-subagent",
      acpSessionId: "source-acp-subagent",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      kind: "subagent",
    });

    const result = await runCli(
      ["codex", "sessions", "copy", "--from", "source-subagent"],
      homeDir,
    );

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Cannot copy a subagent session/);
  });
});

test("sessions ensure creates when missing and returns existing on subsequent calls", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout.trim()) as Record<string, unknown>;
    assert.equal(firstPayload.action, "session_ensured");
    assert.equal(firstPayload.created, true);

    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    assert.equal(secondPayload.action, "session_ensured");
    assert.equal(secondPayload.created, false);
    assert.equal(secondPayload.acpxRecordId, firstPayload.acpxRecordId);
  });
});

test("sessions new and ensure accept -s as shorthand for --name", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "-s", "ci"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout.trim()) as Record<string, unknown>;
    assert.equal(createdPayload.name, "ci");

    const ensured = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "ci"],
      homeDir,
    );
    assert.equal(ensured.code, 0, ensured.stderr);
    const ensuredPayload = JSON.parse(ensured.stdout.trim()) as Record<string, unknown>;
    assert.equal(ensuredPayload.action, "session_ensured");
    assert.equal(ensuredPayload.created, false);
    assert.equal(ensuredPayload.name, "ci");
  });
});

test("explicit unknown --subscription fails before spawn or persistence at runtime entry points", async () => {
  const scenarios = [
    {
      name: "sessions new",
      args: (cwd: string) => [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--subscription",
        "ghost",
        "sessions",
        "new",
      ],
    },
    {
      name: "sessions ensure",
      args: (cwd: string) => [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--subscription",
        "ghost",
        "sessions",
        "ensure",
      ],
    },
    {
      name: "exec",
      args: (cwd: string) => [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--subscription",
        "ghost",
        "exec",
        "echo hello",
      ],
    },
  ];

  for (const scenario of scenarios) {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      await writeSubscriptionRegistry(homeDir);

      const result = await runCli(scenario.args(cwd), homeDir);

      assert.notEqual(result.code, 0, `${scenario.name} unexpectedly succeeded`);
      assert.match(result.stderr, /subscription "ghost" not found in registry/);
      assert.match(result.stderr, /Known subscription ids: sub1, sub2/);
      assert.deepEqual(await listSessionRecordFiles(homeDir), []);
    });
  }

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeSubscriptionRegistry(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "subscription-prompt-session",
      acpSessionId: "subscription-prompt-session",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      acpx: {
        session_options: {
          subscription: "sub1",
        },
      },
    });
    const sessionPath = sessionFilePath(homeDir, "subscription-prompt-session");
    const before = await fs.readFile(sessionPath, "utf8");

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--subscription",
        "ghost",
        "prompt",
        "echo hello",
      ],
      homeDir,
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /subscription "ghost" not found in registry/);
    assert.match(result.stderr, /Known subscription ids: sub1, sub2/);
    assert.deepEqual(await listSessionRecordFiles(homeDir), ["subscription-prompt-session.json"]);
    assert.equal(await fs.readFile(sessionPath, "utf8"), before);
  });
});

test("explicit valid --subscription on existing persistent sessions must apply or fail loud", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const agentCommand = `${MOCK_AGENT_COMMAND} --supports-load-session --env-dump-file ${JSON.stringify(envDumpFile)}`;
    const sub1Dir = path.join(homeDir, ".acpx", "subscriptions", "sub1");
    await fs.mkdir(cwd, { recursive: true });
    await writeSubscriptionRegistry(homeDir);

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub1",
        "--format",
        "json",
        "sessions",
        "new",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown };
    assert.equal(typeof createdPayload.acpxRecordId, "string");

    const samePrompt = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub1",
        "--format",
        "quiet",
        "--ttl",
        "1",
        "prompt",
        "echo same-sub",
      ],
      homeDir,
      { timeoutMs: 20_000 },
    );
    assert.equal(samePrompt.code, 0, samePrompt.stderr);
    assert.match(samePrompt.stdout, /same-sub/);

    const promptEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(promptEnv.CLAUDE_CONFIG_DIR, sub1Dir);
    assert.equal(promptEnv.ACPX_SUBSCRIPTION, "sub1");

    const sameEnsure = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--subscription",
        "sub1",
        "--format",
        "json",
        "sessions",
        "ensure",
      ],
      homeDir,
    );
    assert.equal(sameEnsure.code, 0, sameEnsure.stderr);
    const sameEnsurePayload = JSON.parse(sameEnsure.stdout.trim()) as {
      created?: unknown;
    };
    assert.equal(sameEnsurePayload.created, false);
  });

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const agentCommand = `${MOCK_AGENT_COMMAND} --supports-load-session --env-dump-file ${JSON.stringify(envDumpFile)}`;
    const sub2Dir = path.join(homeDir, ".acpx", "subscriptions", "sub2");
    await fs.mkdir(cwd, { recursive: true });
    await writeSubscriptionRegistry(homeDir);

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub1",
        "--format",
        "json",
        "sessions",
        "new",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown };
    assert.equal(typeof createdPayload.acpxRecordId, "string");
    const sessionPath = sessionFilePath(homeDir, String(createdPayload.acpxRecordId));

    const beforeRejectRecord = await fs.readFile(sessionPath, "utf8");
    const beforeRejectEnv = await fs.readFile(envDumpFile, "utf8");

    const differentPrompt = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub2",
        "prompt",
        "echo should-not-run",
      ],
      homeDir,
    );
    assert.notEqual(differentPrompt.code, 0);
    assert.match(differentPrompt.stderr, /Cannot apply --subscription "sub2"/);
    assert.match(differentPrompt.stderr, /current subscription is "sub1"/);
    assert.match(differentPrompt.stderr, /set subscription sub2/);
    assert.doesNotMatch(differentPrompt.stdout, /should-not-run/);
    assert.equal(await fs.readFile(sessionPath, "utf8"), beforeRejectRecord);
    assert.equal(await fs.readFile(envDumpFile, "utf8"), beforeRejectEnv);

    const differentEnsure = await runCli(
      ["--cwd", cwd, "--agent", agentCommand, "--subscription", "sub2", "sessions", "ensure"],
      homeDir,
    );
    assert.notEqual(differentEnsure.code, 0);
    assert.match(differentEnsure.stderr, /Cannot apply --subscription "sub2"/);
    assert.match(differentEnsure.stderr, /current subscription is "sub1"/);
    assert.equal(await fs.readFile(sessionPath, "utf8"), beforeRejectRecord);

    const execResult = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub2",
        "--format",
        "quiet",
        "exec",
        "echo one-shot",
      ],
      homeDir,
      { timeoutMs: 20_000 },
    );
    assert.equal(execResult.code, 0, execResult.stderr);
    assert.match(execResult.stdout, /one-shot/);
    const execEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(execEnv.CLAUDE_CONFIG_DIR, sub2Dir);
    assert.equal(execEnv.ACPX_SUBSCRIPTION, "sub2");
    assert.equal(await fs.readFile(sessionPath, "utf8"), beforeRejectRecord);

    await writeSessionRecord(homeDir, {
      acpxRecordId: "profile-backed-sub2",
      acpSessionId: "profile-backed-sub2",
      agentCommand,
      cwd,
      name: "profile-backed",
      acpx: {
        session_options: {
          profile: "sub2",
        },
      },
    });
    const profileSame = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub2-same-account",
        "--format",
        "quiet",
        "--ttl",
        "1",
        "prompt",
        "--session",
        "profile-backed",
        "echo profile-backed-same",
      ],
      homeDir,
      { timeoutMs: 20_000 },
    );
    assert.equal(profileSame.code, 0, profileSame.stderr);
    assert.match(profileSame.stdout, /profile-backed-same/);
    const profileSameEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<
      string,
      string
    >;
    assert.equal(profileSameEnv.CLAUDE_CONFIG_DIR, sub2Dir);
    assert.equal(profileSameEnv.ACPX_SUBSCRIPTION, "sub2");

    await writeSessionRecord(homeDir, {
      acpxRecordId: "profile-backed-reject",
      acpSessionId: "profile-backed-reject",
      agentCommand,
      cwd,
      name: "profile-reject",
      acpx: {
        session_options: {
          profile: "sub2",
        },
      },
    });
    const profileRejectPath = sessionFilePath(homeDir, "profile-backed-reject");
    const beforeProfileReject = await fs.readFile(profileRejectPath, "utf8");
    const profileDifferentPrompt = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--approve-all",
        "--subscription",
        "sub1",
        "prompt",
        "--session",
        "profile-reject",
        "echo profile-should-not-run",
      ],
      homeDir,
    );
    assert.notEqual(profileDifferentPrompt.code, 0);
    assert.match(profileDifferentPrompt.stderr, /Cannot apply --subscription "sub1"/);
    assert.match(profileDifferentPrompt.stderr, /current subscription is "sub2"/);
    assert.doesNotMatch(profileDifferentPrompt.stdout, /profile-should-not-run/);
    assert.equal(await fs.readFile(profileRejectPath, "utf8"), beforeProfileReject);

    const profileDifferentEnsure = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        agentCommand,
        "--subscription",
        "sub1",
        "sessions",
        "ensure",
        "--name",
        "profile-reject",
      ],
      homeDir,
    );
    assert.notEqual(profileDifferentEnsure.code, 0);
    assert.match(profileDifferentEnsure.stderr, /Cannot apply --subscription "sub1"/);
    assert.match(profileDifferentEnsure.stderr, /current subscription is "sub2"/);
    assert.equal(await fs.readFile(profileRejectPath, "utf8"), beforeProfileReject);
  });
});

test("sessions new maps inherited effort to the child model's advertised levels", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const claudeCommand = `${MOCK_AGENT_COMMAND} --claude-agent-acp --advertise-models --advertise-config-options`;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            claude: {
              command: claudeCommand,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "parent-opus",
      acpSessionId: "parent-opus",
      agentCommand: claudeCommand,
      cwd,
      acpx: {
        session_options: {
          model: "opus[1m]",
        },
        desired_config_options: {
          effort: "xhigh",
        },
      },
    });

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "--model",
        "sonnet",
        "claude",
        "sessions",
        "new",
        "--parent-id",
        "parent-opus",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const payload = JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown };
    assert.equal(typeof payload.acpxRecordId, "string");
    const childId = payload.acpxRecordId;
    if (typeof childId !== "string") {
      throw new Error("missing child session id");
    }

    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      agent_command?: unknown;
      parent_session_id?: unknown;
      acpx?: {
        session_options?: { model?: unknown };
        desired_config_options?: { effort?: unknown };
        config_options?: Array<{
          id?: unknown;
          currentValue?: unknown;
          options?: Array<{ value?: unknown }>;
        }>;
      };
    };
    assert.equal(stored.agent_command, claudeCommand);
    assert.equal(stored.parent_session_id, "parent-opus");
    assert.equal(stored.acpx?.session_options?.model, "sonnet");
    assert.equal(stored.acpx?.desired_config_options?.effort, "high");

    const effortOption = stored.acpx?.config_options?.find((option) => option.id === "effort");
    assert.equal(effortOption?.currentValue, "high");
    assert.deepEqual(
      effortOption?.options?.map((option) => option.value),
      ["low", "medium", "high"],
    );
  });
});

test("sessions ensure --resume-session loads ACP session when creating missing session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_DISTINCT_CREATE_AND_LOAD_RUNTIME_SESSION_IDS,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const resumeSessionId = "cs_ensure_resume";
    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "ensure",
        "--resume-session",
        resumeSessionId,
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      created?: unknown;
      acpxRecordId?: unknown;
      acpxSessionId?: unknown;
      agentSessionId?: unknown;
    };
    assert.equal(payload.created, true);
    assert.equal(payload.acpxRecordId, resumeSessionId);
    assert.equal(payload.acpxSessionId, resumeSessionId);
    assert.equal(payload.agentSessionId, "resumed-runtime-session");
  });
});

test("sessions ensure exits even when agent ignores SIGTERM", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_IGNORING_SIGTERM,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
      { timeoutMs: 8_000 },
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      action?: unknown;
      created?: unknown;
      acpxRecordId?: unknown;
    };
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, true);
    assert.equal(typeof payload.acpxRecordId, "string");

    const storedRecord = JSON.parse(
      await fs.readFile(
        path.join(
          homeDir,
          ".acpx",
          "sessions",
          `${encodeURIComponent(payload.acpxRecordId as string)}.json`,
        ),
        "utf8",
      ),
    ) as SessionRecord;

    assert.equal(storedRecord.pid, undefined);
  });
});

test("sessions ensure resolves existing session by directory walk", async () => {
  await withTempHome(async (homeDir) => {
    const root = path.join(homeDir, "workspace");
    const child = path.join(root, "packages", "app");
    await fs.mkdir(child, { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "parent-session",
      acpSessionId: "parent-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: root,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", child, "--format", "json", "codex", "sessions", "ensure"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.acpxRecordId, "parent-session");
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, false);
  });
});

test("generic sessions show resolves a uniquely matching non-default agent session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "claude",
          agents: {
            claude: {
              command: "mock-claude-acp",
            },
            codex: {
              command: "mock-codex-acp",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "codex-named-session",
      acpSessionId: "codex-named-session",
      agentCommand: "mock-codex-acp",
      cwd,
      name: "hod-codex-model-steering",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "sessions", "show", "hod-codex-model-steering"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /id: codex-named-session/);
    assert.match(result.stdout, /agent: mock-codex-acp/);
  });
});

test("sessions show and read resolve session ids while preserving name lookup", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const recordId = "11111111-1111-4111-8111-111111111111";
    const acpSessionId = "22222222-2222-4222-8222-222222222222";
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    const messages: SessionRecord["messages"] = [
      { User: { id: "user-1", content: [{ Text: "hello by id" }] } },
      { Agent: { content: [{ Text: "hello from assistant" }], tool_results: {} } },
    ];
    await writeSessionRecord(homeDir, {
      acpxRecordId: recordId,
      acpSessionId,
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "readable-copy",
      messages,
      lastSeq: messages.length,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const showByRecordId = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "show", recordId],
      homeDir,
    );
    assert.equal(showByRecordId.code, 0, showByRecordId.stderr);
    const shownByRecordId = JSON.parse(showByRecordId.stdout.trim()) as SessionRecord;
    assert.equal(shownByRecordId.acpxRecordId, recordId);
    assert.equal(shownByRecordId.acpSessionId, acpSessionId);
    assert.equal(shownByRecordId.name, "readable-copy");

    const readByAcpSessionId = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "read", acpSessionId],
      homeDir,
    );
    assert.equal(readByAcpSessionId.code, 0, readByAcpSessionId.stderr);
    const readByAcpPayload = JSON.parse(readByAcpSessionId.stdout.trim()) as {
      id?: unknown;
      sessionId?: unknown;
      count?: unknown;
      entries?: Array<{ textPreview?: unknown }>;
    };
    assert.equal(readByAcpPayload.id, recordId);
    assert.equal(readByAcpPayload.sessionId, acpSessionId);
    assert.equal(readByAcpPayload.count, messages.length);
    assert.deepEqual(
      readByAcpPayload.entries?.map((entry) => entry.textPreview),
      ["hello by id", "hello from assistant"],
    );

    const showBySuffix = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "show", "222222222222"],
      homeDir,
    );
    assert.equal(showBySuffix.code, 0, showBySuffix.stderr);
    const shownBySuffix = JSON.parse(showBySuffix.stdout.trim()) as SessionRecord;
    assert.equal(shownBySuffix.acpxRecordId, recordId);

    const showByName = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "show", "readable-copy"],
      homeDir,
    );
    assert.equal(showByName.code, 0, showByName.stderr);
    const shownByName = JSON.parse(showByName.stdout.trim()) as SessionRecord;
    assert.equal(shownByName.acpxRecordId, recordId);

    const readByName = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "read", "readable-copy"],
      homeDir,
    );
    assert.equal(readByName.code, 0, readByName.stderr);
    const readByNamePayload = JSON.parse(readByName.stdout.trim()) as { id?: unknown };
    assert.equal(readByNamePayload.id, recordId);
  });
});

test("generic sessions show reports ambiguous cross-agent matches with explicit commands", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "claude",
          agents: {
            claude: {
              command: "mock-claude-acp",
            },
            codex: {
              command: "mock-codex-acp",
            },
            pi: {
              command: "mock-pi-acp",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "codex-ambiguous-session",
      acpSessionId: "codex-ambiguous-session",
      agentCommand: "mock-codex-acp",
      cwd,
      name: "shared",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "pi-ambiguous-session",
      acpSessionId: "pi-ambiguous-session",
      agentCommand: "mock-pi-acp",
      cwd,
      name: "shared",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-02T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(["--cwd", cwd, "sessions", "show", "shared"], homeDir);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Searched default agent claude/);
    assert.match(result.stderr, /acpx codex sessions show shared/);
    assert.match(result.stderr, /acpx pi sessions show shared/);
  });
});

test("sessions and status surface agentSessionId for codex and claude in JSON mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const runtimeScenarios = [
      {
        agentName: "codex",
        command: MOCK_CODEX_AGENT_WITH_RUNTIME_SESSION_ID,
        expectedRuntimeSessionId: "codex-runtime-session",
      },
      {
        agentName: "claude",
        command: MOCK_CLAUDE_AGENT_WITH_RUNTIME_SESSION_ID,
        expectedRuntimeSessionId: "claude-runtime-session",
      },
    ] as const;

    const agentsConfig = Object.fromEntries(
      runtimeScenarios.map((scenario) => [scenario.agentName, { command: scenario.command }]),
    );

    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: agentsConfig,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    for (const scenario of runtimeScenarios) {
      const created = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "sessions", "new"],
        homeDir,
      );
      assert.equal(created.code, 0, created.stderr);
      const createdPayload = JSON.parse(created.stdout.trim()) as Record<string, unknown>;
      assert.equal(createdPayload.action, "session_ensured");
      assert.equal(createdPayload.created, true);
      assert.equal(createdPayload.agentSessionId, scenario.expectedRuntimeSessionId);

      const ensured = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "sessions", "ensure"],
        homeDir,
      );
      assert.equal(ensured.code, 0, ensured.stderr);
      const ensuredPayload = JSON.parse(ensured.stdout.trim()) as Record<string, unknown>;
      assert.equal(ensuredPayload.action, "session_ensured");
      assert.equal(ensuredPayload.created, false);
      assert.equal(ensuredPayload.agentSessionId, scenario.expectedRuntimeSessionId);

      const status = await runCli(
        ["--cwd", cwd, "--format", "json", scenario.agentName, "status"],
        homeDir,
      );
      assert.equal(status.code, 0, status.stderr);
      const statusPayload = JSON.parse(status.stdout.trim()) as Record<string, unknown>;
      assert.equal(statusPayload.action, "status_snapshot");
      assert.equal(statusPayload.agentSessionId, scenario.expectedRuntimeSessionId);
    }
  });
});

test("prompt reconciles agentSessionId from loadSession metadata", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "resume-runtime-session";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const prompt = await runCli(
      ["--cwd", cwd, "--ttl", "0.01", "codex", "prompt", "echo hello"],
      homeDir,
    );
    assert.equal(prompt.code, 0, prompt.stderr);

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(sessionId)}.json`,
    );
    const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(storedRecord.agent_session_id, "loaded-runtime-session");
  });
});

test("set-mode persists across load fallback and replays on fresh ACP sessions", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_LOAD_FALLBACK,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "mode-replay-session";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_FALLBACK,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const setPlan = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set-mode", "plan"],
      homeDir,
    );
    assert.equal(setPlan.code, 0, setPlan.stderr);
    const setPlanPayload = JSON.parse(setPlan.stdout.trim()) as {
      acpxSessionId?: unknown;
    };

    const checkPlan = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set", "reasoning_effort", "high"],
      homeDir,
    );
    assert.equal(checkPlan.code, 0, checkPlan.stderr);
    const checkPlanPayload = JSON.parse(checkPlan.stdout.trim()) as {
      acpxSessionId?: unknown;
      configOptions?: Array<{ id?: string; currentValue?: string }>;
    };
    const modeAfterPlan =
      checkPlanPayload.configOptions?.find((option) => option.id === "mode")?.currentValue ?? "";
    assert.equal(modeAfterPlan, "plan");
    assert.notEqual(checkPlanPayload.acpxSessionId, setPlanPayload.acpxSessionId);

    const setAuto = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set-mode", "auto"],
      homeDir,
    );
    assert.equal(setAuto.code, 0, setAuto.stderr);
    const setAutoPayload = JSON.parse(setAuto.stdout.trim()) as {
      acpxSessionId?: unknown;
    };

    const checkAuto = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set", "reasoning_effort", "medium"],
      homeDir,
    );
    assert.equal(checkAuto.code, 0, checkAuto.stderr);
    const checkAutoPayload = JSON.parse(checkAuto.stdout.trim()) as {
      acpxSessionId?: unknown;
      configOptions?: Array<{ id?: string; currentValue?: string }>;
    };
    const modeAfterAuto =
      checkAutoPayload.configOptions?.find((option) => option.id === "mode")?.currentValue ?? "";
    assert.equal(modeAfterAuto, "auto");
    assert.notEqual(checkAutoPayload.acpxSessionId, setAutoPayload.acpxSessionId);

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(sessionId)}.json`,
    );
    const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
      acpx?: {
        desired_mode_id?: string;
      };
    };
    assert.equal(storedRecord.acpx?.desired_mode_id, "auto");
  });
});

test("codex thought_level passes through for current built-in adapter", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "codex-thought-level-alias";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set", "thought_level", "high"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      action?: string;
      configId?: string;
      value?: string;
    };
    assert.equal(payload.action, "config_set");
    assert.equal(payload.configId, "thought_level");
    assert.equal(payload.value, "high");
  });
});

test("codex set model passes the requested model through unchanged", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "codex-model-alias";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set", "model", "GPT-5-2"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = JSON.parse(result.stdout.trim()) as {
      action?: string;
      modelId?: string;
    };
    assert.equal(payload.action, "model_set");
    assert.equal(payload.modelId, "GPT-5-2");
  });
});

test("set-mode load fallback failure does not persist the fresh session id to disk", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_LOAD_FALLBACK_AND_MODE_FAILURE,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "mode-replay-session";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_FALLBACK_AND_MODE_FAILURE,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
      acpx: {
        desired_mode_id: "plan",
      },
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set-mode", "plan"],
      homeDir,
    );
    assert.equal(result.code, 1, result.stderr);
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.data?.acpxCode, "RUNTIME");
    assert.equal(error.data?.detailCode, "SESSION_MODE_REPLAY_FAILED");

    const storedRecordPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(sessionId)}.json`,
    );
    const storedRecord = JSON.parse(await fs.readFile(storedRecordPath, "utf8")) as {
      acp_session_id?: string;
      acpx?: {
        desired_mode_id?: string;
      };
    };
    assert.equal(storedRecord.acp_session_id, sessionId);
    assert.equal(storedRecord.acpx?.desired_mode_id, "plan");
  });
});

test("set-mode surfaces actionable guidance when agent rejects session/set_mode params", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_SET_MODE_INVALID_PARAMS,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "set-mode-invalid-params";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_SET_MODE_INVALID_PARAMS,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set-mode", "plan"],
      homeDir,
    );
    assert.equal(result.code, 1, result.stderr);
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(typeof error.code, "number");
    assert.match(error.message ?? "", /Internal error|session\/set_mode/);
  });
});

test("set returns an error when agent rejects unsupported session config params", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_WITH_SET_CONFIG_INVALID_PARAMS,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const sessionId = "set-config-invalid-params";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_SET_CONFIG_INVALID_PARAMS,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "set", "approval_policy", "strict"],
      homeDir,
    );
    assert.equal(result.code, 1, result.stderr);
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(typeof error.code, "number");
    assert.match(error.message ?? "", /Internal error|session\/set_config_option/);
  });
});

test("--ttl flag is parsed for sessions commands", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(["--ttl", "30", "--format", "json", "sessions", "--local"], homeDir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.doesNotThrow(() => JSON.parse(ok.stdout.trim()));

    const invalid = await runCli(["--ttl", "bad", "sessions"], homeDir);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /TTL must be a non-negative number of seconds/);

    const negative = await runCli(["--ttl", "-1", "sessions"], homeDir);
    assert.equal(negative.code, 2);
    assert.match(negative.stderr, /TTL must be a non-negative number of seconds/);
  });
});

test("--auth-policy flag validates supported values", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(
      ["--auth-policy", "skip", "--format", "json", "sessions", "--local"],
      homeDir,
    );
    assert.equal(ok.code, 0, ok.stderr);

    const invalid = await runCli(["--auth-policy", "bad", "sessions"], homeDir);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /Invalid auth policy/);
  });
});

test("--non-interactive-permissions validates supported values", async () => {
  await withTempHome(async (homeDir) => {
    const ok = await runCli(
      ["--non-interactive-permissions", "deny", "--format", "json", "sessions", "--local"],
      homeDir,
    );
    assert.equal(ok.code, 0, ok.stderr);

    const invalid = await runCli(
      ["--format", "json", "--non-interactive-permissions", "bad", "sessions"],
      homeDir,
    );
    assert.equal(invalid.code, 2);
    const error = parseSingleAcpErrorLine(invalid.stdout);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(error.message ?? "", /Invalid non-interactive permission policy/);
  });
});

test("--json-strict requires --format json", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["--json-strict", "sessions"], homeDir);
    assert.equal(result.code, 2);
    assert.equal(result.stderr.trim(), "");
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(error.message ?? "", /--json-strict requires --format json/);
  });
});

test("--json-strict rejects --verbose", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(
      ["--format", "json", "--json-strict", "--verbose", "sessions"],
      homeDir,
    );
    assert.equal(result.code, 2);
    assert.equal(result.stderr.trim(), "");
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.code, -32602);
    assert.equal(error.data?.acpxCode, "USAGE");
    assert.match(error.message ?? "", /--json-strict cannot be combined with --verbose/);
  });
});

test("queued prompt failures emit exactly one JSON error event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const blocker = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "codex", "prompt", "sleep 1500"],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      const writeResult = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "--non-interactive-permissions",
          "fail",
          "codex",
          "prompt",
          `write ${path.join(cwd, "x.txt")} hi`,
        ],
        homeDir,
      );

      assert.equal(writeResult.code, 5, writeResult.stderr);

      const events = writeResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const errors = events.filter(
        (event) => typeof event.error === "object" && event.error !== null,
      );
      assert.equal(errors.length, 1, writeResult.stdout);
      assert.equal((errors[0]?.error as { code?: unknown } | undefined)?.code, -32603);
      assert.notEqual(
        (errors[0]?.error as { data?: { sessionId?: unknown } } | undefined)?.data?.sessionId,
        "unknown",
      );
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          blocker.once("close", () => resolve());
        });
      }
    }
  });
});

test("json-strict queued prompt failure emits JSON-RPC lines only", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const blocker = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "codex", "prompt", "sleep 1500"],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      const writeResult = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "--json-strict",
          "--non-interactive-permissions",
          "fail",
          "codex",
          "prompt",
          `write ${path.join(cwd, "x.txt")} hi`,
        ],
        homeDir,
      );

      assert.equal(writeResult.code, 5, writeResult.stderr);
      assert.equal(writeResult.stderr.trim(), "");

      const events = parseJsonRpcLines(writeResult.stdout);
      assert.equal(
        events.some(
          (event) =>
            typeof event.error === "object" &&
            event.error !== null &&
            typeof (event.error as { code?: unknown }).code === "number",
        ),
        true,
      );
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          blocker.once("close", () => resolve());
        });
      }
    }
  });
});

test("queued prompt failures remain visible in quiet mode", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const blocker = spawn(
      process.execPath,
      [CLI_PATH, "--cwd", cwd, "codex", "prompt", "sleep 1500"],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      const writeResult = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "quiet",
          "--non-interactive-permissions",
          "fail",
          "codex",
          "prompt",
          `write ${path.join(cwd, "x.txt")} hi`,
        ],
        homeDir,
      );

      assert.equal(writeResult.code, 5);
      assert.match(writeResult.stdout, /error:\s*Internal error/i);
      assert.match(writeResult.stderr, /Permission prompt unavailable in non-interactive mode/);
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          blocker.once("close", () => resolve());
        });
      }
    }
  });
});

test("non-queued write permission denial exits with code 5", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(session.code, 0, session.stderr);

    const writeResult = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "quiet",
        "--approve-reads",
        "codex",
        "prompt",
        `write ${path.join(cwd, "x.txt")} hi`,
      ],
      homeDir,
    );

    assert.equal(writeResult.code, 5);
    assert.match(writeResult.stdout, /error:\s*Internal error/i);
  });
});

test("--json-strict suppresses session banners on stderr", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: {
              command: MOCK_AGENT_COMMAND,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "--json-strict", "codex", "sessions", "new"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, true);
    assert.equal(typeof payload.acpxRecordId, "string");
  });
});

test("prompt exits with NO_SESSION when no session exists (no auto-create)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "hello"], homeDir);

    assert.equal(result.code, 4);
    const escapedCwd = escapeRegex(cwd);
    assert.match(
      result.stderr,
      new RegExp(
        `⚠ No acpx session found \\(searched up to ${escapedCwd}\\)\\.\\nCreate one: acpx codex sessions new\\n?`,
      ),
    );
  });
});

test("json format emits structured no-session error event", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "--format", "json", "codex", "hello"], homeDir);
    assert.equal(result.code, 4);
    const error = parseSingleAcpErrorLine(result.stdout);
    assert.equal(error.code, -32002);
    assert.equal(error.data?.acpxCode, "NO_SESSION");
    assert.match(error.message ?? "", /No acpx session found/);
  });
});

test("set-mode exits with NO_SESSION when no session exists", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "set-mode", "plan"], homeDir);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
  });
});

test("set command exits with NO_SESSION when no session exists", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "set", "temperature", "high"], homeDir);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
  });
});

test("cancel prints nothing to cancel and exits success when no session exists", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace", "packages", "app");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex", "cancel"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /nothing to cancel/);
  });
});

test("cancel resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-cancel-session",
      acpSessionId: "named-cancel-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "-s", "named", "cancel"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "cancel_result");
    assert.equal(payload.acpxRecordId, "named-cancel-session");
    assert.equal(payload.cancelled, false);
  });
});

test("status resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-status-session",
      acpSessionId: "named-status-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "-s", "named", "status"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "status_snapshot");
    assert.equal(payload.acpxRecordId, "named-status-session");
    assert.equal(payload.status, "idle");
    assert.equal(payload.summary, "session idle; queue owner will start on next prompt");
    assert.notEqual(payload.status, "no-session");
    assert.equal(payload.agentSessionId, undefined);
  });
});

test("status reports idle for resumable sessions without a live queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const keeper = await startKeeperProcess();

    try {
      await writeSessionRecord(homeDir, {
        acpxRecordId: "idle-status-session",
        acpSessionId: "idle-status-session",
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:01:00.000Z",
        lastPromptAt: "2026-01-01T00:01:00.000Z",
        closed: false,
        pid: keeper.pid,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
        lastAgentExitCode: 0,
        lastAgentExitAt: "2026-01-01T00:02:00.000Z",
      });

      const json = await runCli(["--cwd", cwd, "--format", "json", "codex", "status"], homeDir);
      assert.equal(json.code, 0, json.stderr);
      const payload = JSON.parse(json.stdout.trim()) as Record<string, unknown>;
      assert.equal(payload.action, "status_snapshot");
      assert.equal(payload.status, "idle");
      assert.equal(payload.summary, "session idle; queue owner will start on next prompt");
      assert.equal(payload.pid, undefined);
      assert.equal(payload.exitCode, undefined);

      const text = await runCli(["--cwd", cwd, "codex", "status"], homeDir);
      assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /status: idle/);
      assert.match(text.stdout, /pid: -/);
      assert.doesNotMatch(text.stdout, /exitCode:/);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("set-mode resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    const missingAgentCommand = "acpx-test-missing-agent-binary";
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: { command: missingAgentCommand },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-set-mode-session",
      acpSessionId: "named-set-mode-session",
      agentCommand: missingAgentCommand,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "codex", "-s", "named", "set-mode", "plan"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /No acpx session found/);
    assert.match(result.stderr, /ENOENT|spawn|not found/i);
  });
});

test("set resolves named session when -s is before subcommand", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    const missingAgentCommand = "acpx-test-missing-agent-binary-2";
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          agents: {
            codex: { command: missingAgentCommand },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "named-set-config-session",
      acpSessionId: "named-set-config-session",
      agentCommand: missingAgentCommand,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(
      ["--cwd", cwd, "codex", "-s", "named", "set", "approval_policy", "strict"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /No acpx session found/);
    assert.match(result.stderr, /ENOENT|spawn|not found/i);
  });
});

test("prompt reads from stdin when no prompt argument is provided", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(["--cwd", cwd, "codex"], homeDir, {
      stdin: "fix the tests\n",
    });

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /Prompt is required/);
  });
});

test("prompt reads from --file for persistent prompts", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "prompt.md"), "fix the tests\n", "utf8");

    const result = await runCli(["--cwd", cwd, "codex", "--file", "prompt.md"], homeDir);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /Prompt is required/);
  });
});

test("prompt supports --file - with additional argument text", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--cwd", cwd, "codex", "--file", "-", "additional context"],
      homeDir,
      { stdin: "from stdin\n" },
    );

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /Prompt is required/);
  });
});

test("exec accepts structured ACP prompt blocks from stdin", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "--format", "quiet", "exec"],
      homeDir,
      {
        stdin: JSON.stringify([
          { type: "text", text: "inspect-prompt" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
        ]),
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Array<Record<string, unknown>>;
    assert.deepEqual(payload, [
      { type: "text", text: "inspect-prompt" },
      { type: "image", mimeType: "image/png", bytes: 8 },
      { type: "audio", mimeType: "audio/wav", bytes: 8 },
    ]);
  });
});

test("prompt preserves structured ACP prompt blocks through the queue owner", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const created = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "sessions", "new"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);

    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "--format", "quiet", "prompt"],
      homeDir,
      {
        stdin: JSON.stringify([
          { type: "text", text: "inspect-prompt" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
        ]),
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Array<Record<string, unknown>>;
    assert.deepEqual(payload, [
      { type: "text", text: "inspect-prompt" },
      { type: "image", mimeType: "image/png", bytes: 8 },
      { type: "audio", mimeType: "audio/wav", bytes: 8 },
    ]);
  });
});

test("exec rejects structured image prompts with invalid mime types", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "--format", "quiet", "exec"],
      homeDir,
      {
        stdin: JSON.stringify([
          { type: "text", text: "inspect-prompt" },
          { type: "image", mimeType: "application/json", data: "aW1hZ2U=" },
        ]),
      },
    );

    assert.equal(result.code, 2);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /image block mimeType must start with image\//i,
    );
  });
});

test("exec rejects structured image prompts with invalid base64 payloads", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "--cwd", cwd, "--format", "quiet", "exec"],
      homeDir,
      {
        stdin: JSON.stringify([
          { type: "text", text: "inspect-prompt" },
          { type: "image", mimeType: "image/png", data: "%%%" },
        ]),
      },
    );

    assert.equal(result.code, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /image block data must be valid base64/i);
  });
});

test("prompt subcommand accepts --file without being consumed by parent command", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "prompt.md"), "fix the tests\n", "utf8");

    const result = await runCli(["--cwd", cwd, "codex", "prompt", "--file", "prompt.md"], homeDir);

    assert.equal(result.code, 4);
    assert.match(result.stderr, /No acpx session found/);
    assert.doesNotMatch(result.stderr, /unknown option/i);
  });
});

test("exec subcommand accepts --file without being consumed by parent command", async () => {
  await withTempHome(async (homeDir) => {
    const promptPath = path.join(homeDir, "prompt.txt");
    await fs.writeFile(promptPath, "say exactly: file-flag-test\n", "utf8");

    const result = await runCli(["custom-agent", "exec", "--file", promptPath], homeDir);

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /unknown option/i);
  });
});

test("sessions history prints stored history entries", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "history-session",
      acpSessionId: "history-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
      title: null,
      messages: [
        {
          User: {
            id: "7d7b0e67-9725-4f57-ba31-491bf4f97767",
            content: [{ Text: "first message" }],
          },
        },
        {
          Agent: {
            content: [{ Text: "second message" }],
            tool_results: {},
          },
        },
      ],
      updated_at: "2026-01-01T00:02:00.000Z",
      cumulative_token_usage: {},
      request_token_usage: {},
    });

    const result = await runCli(
      ["--cwd", cwd, "codex", "sessions", "history", "--limit", "1"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /second message/);
    assert.doesNotMatch(result.stdout, /first message/);
  });
});

test("sessions import --cwd overrides the destination cwd without replacing global cwd", async () => {
  await withTempHome(async (homeDir) => {
    const sourceCwd = path.join(homeDir, "source");
    const destinationCwd = path.join(homeDir, "restored");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(sourceCwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "export-source",
      acpSessionId: "provider-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: sourceCwd,
      name: "debug",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
    });

    const exported = await runCli(
      [
        "--cwd",
        sourceCwd,
        "--format",
        "quiet",
        "codex",
        "sessions",
        "export",
        "debug",
        "--output",
        archivePath,
      ],
      homeDir,
    );
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(exported.stdout.trim(), archivePath);
    await fs.rm(sessionFilePath(homeDir, "export-source"));

    const imported = await runCli(
      [
        "--cwd",
        sourceCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "import",
        archivePath,
        "--name",
        "debug-copy",
        "--cwd",
        destinationCwd,
      ],
      homeDir,
    );
    assert.equal(imported.code, 0, imported.stderr);
    const payload = JSON.parse(imported.stdout) as { record_id?: string; cwd?: string };
    assert.equal(payload.cwd, destinationCwd);
    assert.equal(typeof payload.record_id, "string");

    const record = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, payload.record_id ?? ""), "utf8"),
    ) as { cwd?: string; name?: string };
    assert.equal(record.cwd, destinationCwd);
    assert.equal(record.name, "debug-copy");
  });
});

test("sessions export omits agent_name for raw --agent overrides", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "raw-agent-source",
      acpSessionId: "provider-session",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      name: "debug",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
    });

    const exported = await runCli(
      [
        "--agent",
        MOCK_AGENT_COMMAND,
        "--cwd",
        cwd,
        "--format",
        "quiet",
        "sessions",
        "export",
        "debug",
        "--output",
        archivePath,
      ],
      homeDir,
    );
    assert.equal(exported.code, 0, exported.stderr);

    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { agent_name?: unknown };
    };
    assert.equal(archive.session?.agent_name, undefined);
  });
});

test("sessions import rejects archives for a different invoked agent", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const archivePath = path.join(homeDir, "archive.json");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "codex-export-source",
      acpSessionId: "provider-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "debug",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
    });

    const exported = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "quiet",
        "codex",
        "sessions",
        "export",
        "debug",
        "--output",
        archivePath,
      ],
      homeDir,
    );
    assert.equal(exported.code, 0, exported.stderr);

    const imported = await runCli(
      ["--cwd", cwd, "claude", "sessions", "import", archivePath, "--name", "wrong-agent"],
      homeDir,
    );
    assert.equal(imported.code, 2);
    assert.match(imported.stderr, /does not match the requested agent/);
  });
});

test("sessions prune dry-run previews closed sessions without deleting", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "prune-dry-run",
      acpSessionId: "prune-dry-run",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: true,
      closedAt: "2026-01-01T00:10:00.000Z",
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "prune-open",
      acpSessionId: "prune-open",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:20:00.000Z",
      closed: false,
    });

    const result = await runCli(["--cwd", cwd, "codex", "sessions", "prune", "--dry-run"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[DRY RUN\] Would prune 1 session/);
    assert.match(result.stdout, /prune-dry-run/);
    assert.doesNotMatch(result.stdout, /prune-open/);
    assert.ok(await fileExists(sessionFilePath(homeDir, "prune-dry-run")));
    assert.ok(await fileExists(sessionFilePath(homeDir, "prune-open")));
  });
});

test("sessions prune supports json output and include-history", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "prune-json",
      acpSessionId: "prune-json",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: true,
      closedAt: "2026-01-01T00:10:00.000Z",
    });

    const safeId = encodeURIComponent("prune-json");
    const streamFile = path.join(sessionDir, `${safeId}.stream.ndjson`);
    await fs.writeFile(streamFile, "event-data\n", "utf8");

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "prune", "--include-history"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      action?: string;
      dryRun?: boolean;
      count?: number;
      bytesFreed?: number;
      pruned?: string[];
    };
    assert.equal(payload.action, "sessions_pruned");
    assert.equal(payload.dryRun, false);
    assert.equal(payload.count, 1);
    assert.ok((payload.bytesFreed ?? 0) > 0);
    assert.deepEqual(payload.pruned, ["prune-json"]);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "prune-json"))));
    assert.ok(!(await fileExists(streamFile)));
  });
});

test("sessions read prints full history by default and supports --tail", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "read-session",
      acpSessionId: "read-session",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: false,
      title: null,
      messages: [
        {
          User: {
            id: "4cb89fd7-0dd5-4bdd-8f50-3de20eaa58a5",
            content: [{ Text: "first message" }],
          },
        },
        {
          Agent: {
            content: [{ Text: "second message" }],
            tool_results: {},
          },
        },
      ],
      updated_at: "2026-01-01T00:02:00.000Z",
      cumulative_token_usage: {},
      request_token_usage: {},
    });

    const full = await runCli(["--cwd", cwd, "codex", "sessions", "read"], homeDir);
    assert.equal(full.code, 0, full.stderr);
    assert.match(full.stdout, /first message/);
    assert.match(full.stdout, /second message/);
    assert.match(full.stdout, /\(2\/2 shown\)/);

    const tail = await runCli(["--cwd", cwd, "codex", "sessions", "read", "--tail", "1"], homeDir);
    assert.equal(tail.code, 0, tail.stderr);
    assert.match(tail.stdout, /second message/);
    assert.doesNotMatch(tail.stdout, /first message/);
    assert.match(tail.stdout, /\(1\/2 shown\)/);
  });
});

test("status reports running queue owner when owner socket is reachable", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "status-live";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    const server = net.createServer((socket) => {
      socket.end();
    });

    try {
      await writeSessionRecord(homeDir, {
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:00:00.000Z",
        closed: false,
        pid: keeper.pid,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
      });

      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });
      await listenServer(server, socketPath);

      const result = await runCli(["--cwd", cwd, "codex", "status"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /status: running/);
    } finally {
      await closeServer(server);
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("status reports dead when queue owner lease is present but unreachable", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "status-unreachable-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeSessionRecord(homeDir, {
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: AGENT_REGISTRY.codex,
        cwd,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:00:00.000Z",
        closed: false,
        pid: keeper.pid,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
      });

      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });

      const result = await runCli(["--cwd", cwd, "--format", "json", "codex", "status"], homeDir);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      assert.equal(payload.status, "dead");
      assert.equal(payload.summary, "queue owner unavailable");
    } finally {
      await cleanupOwnerArtifacts({ socketPath, lockPath });
      stopProcess(keeper);
    }
  });
});

test("config defaults are loaded from global and project config files", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          defaultAgent: "codex",
          format: "json",
          agents: {
            "my-custom": { command: "custom-global" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(cwd, ".acpxrc.json"),
      `${JSON.stringify(
        {
          agents: {
            "my-custom": { command: "custom-project" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeSessionRecord(homeDir, {
      acpxRecordId: "custom-config-session",
      acpSessionId: "custom-config-session",
      agentCommand: "custom-project",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const result = await runCli(["--cwd", cwd, "my-custom", "sessions", "--local"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout.trim()));
    assert.match(result.stdout, /custom-config-session/);
  });
});

test("exec subcommand is blocked when disableExec is true", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          disableExec: true,
          agents: {
            codex: { command: MOCK_AGENT_COMMAND },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(["--cwd", cwd, "codex", "exec", "hello"], homeDir);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /exec subcommand is disabled by configuration/);
  });
});

test("exec subcommand is blocked in json format when disableExec is true", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          disableExec: true,
          agents: {
            codex: { command: MOCK_AGENT_COMMAND },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "exec", "hello"],
      homeDir,
    );

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout.trim()) as {
      error?: { code?: number; data?: { acpxCode?: string } };
    };
    assert.equal(payload.error?.code, -32603);
    assert.equal(payload.error?.data?.acpxCode, "EXEC_DISABLED");
  });
});

test("exec subcommand works when disableExec is false", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        {
          disableExec: false,
          agents: {
            codex: { command: MOCK_AGENT_COMMAND },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "exec", "echo hello"],
      homeDir,
    );

    // exec should work (exit code 0) since disableExec is false
    assert.equal(result.code, 0, result.stderr);
  });
});

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-cli-test-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

type CliRunOptions = {
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

async function runShell(command: string, env: NodeJS.ProcessEnv = {}): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn("/bin/bash", ["-o", "pipefail", "-c", command], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ...options.env,
    };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
    ]) {
      if (!Object.prototype.hasOwnProperty.call(options.env ?? {}, key)) {
        delete env[key];
      }
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (options.stdin != null) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    if (options.timeoutMs != null && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }, options.timeoutMs);
    }

    child.once("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        stderr += `[test] timed out after ${options.timeoutMs}ms\n`;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function writeSubscriptionRegistry(homeDir: string): Promise<void> {
  const subscriptionsRoot = path.join(homeDir, ".acpx", "subscriptions");
  await fs.mkdir(path.join(subscriptionsRoot, "sub1"), { recursive: true });
  await fs.mkdir(path.join(subscriptionsRoot, "sub2"), { recursive: true });
  await fs.mkdir(path.join(subscriptionsRoot, "sub2-same-account"), { recursive: true });
  await fs.writeFile(
    path.join(subscriptionsRoot, "registry.json"),
    `${JSON.stringify(
      {
        version: 3,
        default: "sub1",
        profiles: [
          {
            id: "sub1",
            label: "Sub 1",
            authMode: "subscription",
            adapter: "claude",
            account: "acct-a",
            credentialSource: path.join(subscriptionsRoot, "sub1"),
          },
          {
            id: "sub2",
            label: "Sub 2",
            authMode: "subscription",
            adapter: "claude",
            account: "acct-b",
            credentialSource: path.join(subscriptionsRoot, "sub2"),
          },
          {
            id: "sub2-same-account",
            label: "Sub 2 Same Account",
            authMode: "subscription",
            adapter: "claude",
            account: "acct-b",
            credentialSource: path.join(subscriptionsRoot, "sub2-same-account"),
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function listSessionRecordFiles(homeDir: string): Promise<string[]> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  try {
    const entries = await fs.readdir(sessionDir);
    return entries.filter((entry) => entry.endsWith(".json") && entry !== "index.json").toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function makeSessionRecord(
  record: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
    createdAt?: string;
    lastUsedAt?: string;
  },
): SessionRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentSessionId: record.agentSessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    createdAt: record.createdAt ?? timestamp,
    lastUsedAt: record.lastUsedAt ?? timestamp,
    lastSeq: record.lastSeq ?? 0,
    lastRequestId: record.lastRequestId,
    eventLog: record.eventLog ?? {
      active_path: `.stream.ndjson`,
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: record.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: record.closed ?? false,
    closedAt: record.closedAt,
    pid: record.pid,
    agentStartedAt: record.agentStartedAt,
    lastPromptAt: record.lastPromptAt,
    lastAgentExitCode: record.lastAgentExitCode,
    lastAgentExitSignal: record.lastAgentExitSignal,
    lastAgentExitAt: record.lastAgentExitAt,
    lastAgentDisconnectReason: record.lastAgentDisconnectReason,
    protocolVersion: record.protocolVersion,
    agentCapabilities: record.agentCapabilities,
    title: record.title ?? null,
    messages: record.messages ?? [],
    updated_at: record.updated_at ?? record.lastUsedAt ?? timestamp,
    cumulative_token_usage: record.cumulative_token_usage ?? {},
    request_token_usage: record.request_token_usage ?? {},
    acpx: record.acpx,
    kind: record.kind,
    parentSessionId: record.parentSessionId,
    forkedFromSessionId: record.forkedFromSessionId,
    forkedAtMessageIndex: record.forkedAtMessageIndex,
    metadata: record.metadata,
    importedFrom: record.importedFrom,
  };
}

async function writeSessionRecord(
  homeDir: string,
  record: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `${encodeURIComponent(record.acpxRecordId)}.json`);
  await fs.writeFile(
    file,
    `${JSON.stringify(serializeSessionRecordForDisk(makeSessionRecord(record)), null, 2)}\n`,
    "utf8",
  );
}

function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(acpxRecordId)}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── FW-11: `sessions templates` (list) + `sessions new --from-template` ───────

// Write an on-disk session record carrying an acpx-ui-owned `template` block.
// makeSessionRecord (the fixture) intentionally omits the field, so inject it
// onto the serialized record the way acpx-ui's PATCH /template does; the daemon
// parser round-trips it back into record.template.
async function writeRecordWithTemplate(
  homeDir: string,
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
  template?: { enabled: boolean; created_at: string },
): Promise<void> {
  const onDisk = serializeSessionRecordForDisk(makeSessionRecord(overrides));
  if (template) {
    onDisk["template"] = template;
  }
  const dir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${encodeURIComponent(overrides.acpxRecordId)}.json`),
    `${JSON.stringify(onDisk, null, 2)}\n`,
    "utf8",
  );
}

async function writeCodexAgentConfig(homeDir: string, command: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { codex: { command } } }, null, 2)}\n`,
    "utf8",
  );
}

test("sessions templates lists only the agent's template records", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);

    await writeRecordWithTemplate(
      homeDir,
      {
        acpxRecordId: "tmpl-a",
        acpSessionId: "acp-a",
        agentName: "codex",
        agentCommand: MOCK_AGENT_COMMAND,
        cwd,
        name: "alpha",
      },
      { enabled: true, created_at: "2026-06-01T00:00:00.000Z" },
    );
    await writeRecordWithTemplate(
      homeDir,
      {
        acpxRecordId: "tmpl-b",
        acpSessionId: "acp-b",
        agentName: "codex",
        agentCommand: MOCK_AGENT_COMMAND,
        cwd,
        name: "beta",
      },
      { enabled: true, created_at: "2026-06-02T00:00:00.000Z" },
    );
    // A plain (non-template) record for the same agent — must be excluded.
    await writeRecordWithTemplate(homeDir, {
      acpxRecordId: "plain-c",
      acpSessionId: "acp-c",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      name: "gamma",
    });

    const result = await runCli(["--format", "json", "codex", "sessions", "templates"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    const listed = JSON.parse(result.stdout.trim()) as Array<{
      acpxRecordId: string;
      template?: { enabled?: boolean };
    }>;
    assert.deepEqual(new Set(listed.map((s) => s.acpxRecordId)), new Set(["tmpl-a", "tmpl-b"]));
    for (const s of listed) {
      assert.equal(s.template?.enabled, true);
    }
  });
});

test("sessions new --from-template rejects a non-template source", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    // Copyable, but NOT a template — assertTemplateSource must reject it.
    await writeRecordWithTemplate(homeDir, {
      acpxRecordId: "not-a-template",
      acpSessionId: "acp-not-tmpl",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      lastSeq: 1,
      messages: [{ User: { id: "u1", content: [{ Text: "hi" }] } }],
    });

    const result = await runCli(
      ["codex", "sessions", "new", "--from-template", "not-a-template"],
      homeDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stderr}${result.stdout}`, /not a template/i);
  });
});

test("sessions new --from-template instantiates a normal open session from a template", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    const messages: SessionRecord["messages"] = [
      { User: { id: "u1", content: [{ Text: "scaffold" }] } },
      { Agent: { content: [{ Text: "ready" }], tool_results: {} } },
    ];
    // A realistic template: closed + template.enabled, as acpx-ui writes it.
    await writeRecordWithTemplate(
      homeDir,
      {
        acpxRecordId: "tmpl-src",
        acpSessionId: "acp-tmpl-src",
        agentName: "codex",
        agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
        cwd,
        name: "blueprint",
        lastSeq: messages.length,
        messages,
        closed: true,
      },
      { enabled: true, created_at: "2026-06-01T05:00:00.000Z" },
    );

    const result = await runCli(
      [
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--from-template",
        "tmpl-src",
        "--name",
        "instance",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      action?: unknown;
      acpxRecordId?: unknown;
      sourceSessionId?: unknown;
    };
    assert.equal(payload.action, "session_copied");
    assert.equal(payload.sourceSessionId, "tmpl-src");

    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, String(payload.acpxRecordId)), "utf8"),
    ) as {
      template?: unknown;
      closed?: unknown;
      agent_command?: unknown;
      messages?: unknown[];
      name?: unknown;
    };
    assert.equal(stored.template, undefined, "instantiated session must NOT itself be a template");
    assert.notEqual(stored.closed, true, "instantiated session must be a normal OPEN session");
    assert.equal(
      stored.agent_command,
      MOCK_AGENT_WITH_FORK_SESSION,
      "inherits the template's agent type",
    );
    assert.deepEqual(stored.messages, messages, "inherits the template's context");
    assert.equal(stored.name, "instance");
  });
});
