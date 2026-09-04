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
  classifyConnectionStatus,
  formatPromptSessionBannerLine,
  parseAllowedTools,
  parseMaxTurns,
  parseTtlSeconds,
} from "../src/cli.js";
import { FORK_NOTICE_MARKER } from "../src/cli/session/fork-handoff.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { DEFAULT_CODEX_MODEL } from "../src/session/default-model.js";
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
const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");
const BRICK_X = "11111111-2222-3333-4444-555555555555";
const BRICK_Z = "99999999-8888-7777-6666-555555555555";
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
const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark[medium]";

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

test("codex exec without --model applies the built-in create-time default before prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const operationLog = path.join(homeDir, "codex-default-ops.jsonl");
    const codexCommand = mockCodexCommand(operationLog);
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      ["--cwd", cwd, "--approve-all", "--format", "quiet", "codex", "exec", "echo ok"],
      homeDir,
      { env: { ACPX_CODEX_ACP_COMMAND: codexCommand } },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ok/);
    const operations = await readMockOperations(operationLog);
    assert.deepEqual(
      operations.map((operation) => operation.method),
      ["session/new", "session/set_model", "session/prompt"],
    );
    assert.equal(operations[1]?.modelId, DEFAULT_CODEX_MODEL);
  });
});

test("codex exec preserves an explicit --model over the create-time default", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const operationLog = path.join(homeDir, "codex-explicit-ops.jsonl");
    const codexCommand = mockCodexCommand(operationLog);
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "quiet",
        "--model",
        CODEX_SPARK_MODEL,
        "codex",
        "exec",
        "echo explicit",
      ],
      homeDir,
      { env: { ACPX_CODEX_ACP_COMMAND: codexCommand } },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /explicit/);
    const operations = await readMockOperations(operationLog);
    const setModel = operations.find((operation) => operation.method === "session/set_model");
    assert.equal(setModel?.modelId, CODEX_SPARK_MODEL);
  });
});

test("codex child session inherits parent model instead of the create-time default", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const operationLog = path.join(homeDir, "codex-inherit-ops.jsonl");
    const codexCommand = mockCodexCommand(operationLog);
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "codex-parent",
      acpSessionId: "codex-parent",
      agentCommand: codexCommand,
      cwd,
      acpx: {
        current_model_id: CODEX_SPARK_MODEL,
        available_models: [DEFAULT_CODEX_MODEL, CODEX_SPARK_MODEL],
        session_options: {
          model: CODEX_SPARK_MODEL,
        },
      },
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--parent-id", "codex-parent"],
      homeDir,
      { env: { ACPX_CODEX_ACP_COMMAND: codexCommand } },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
    assert.equal(typeof payload.acpxRecordId, "string");
    const childId = String(payload.acpxRecordId);
    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      parent_session_id?: unknown;
      acpx?: {
        current_model_id?: unknown;
        session_options?: { model?: unknown };
      };
    };
    assert.equal(stored.parent_session_id, "codex-parent");
    assert.equal(stored.acpx?.session_options?.model, CODEX_SPARK_MODEL);
    assert.equal(stored.acpx?.current_model_id, CODEX_SPARK_MODEL);

    const setModel = (await readMockOperations(operationLog)).find(
      (operation) => operation.method === "session/set_model",
    );
    assert.equal(setModel?.modelId, CODEX_SPARK_MODEL);
  });
});

// brick://5bac5564 — end-to-end record-level proof of the Fable invariant + the
// general re-ensure clobber fix. Each runs the REAL built CLI against the mock
// claude adapter and reads the outcome from the written session RECORD.
const GUARD_CLAUDE_COMMAND = `${MOCK_AGENT_COMMAND} --claude-agent-acp`;

async function writeGuardConfig(homeDir: string): Promise<string> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { claude: { command: GUARD_CLAUDE_COMMAND } } }, null, 2)}\n`,
    "utf8",
  );
  return cwd;
}

type StoredModelState = {
  acpx?: {
    current_model_id?: unknown;
    session_options?: {
      model?: unknown;
      model_source?: unknown;
      model_guard?: { blocked?: unknown };
    };
  };
};

async function readStoredModel(homeDir: string, id: string): Promise<StoredModelState> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as StoredModelState;
}

test("R1 (brick://5bac5564): a bare child of a Fable-pinned parent is guarded to non-Fable", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "fable-parent",
      acpSessionId: "fable-parent",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "fable",
        available_models: ["fable", "opus", "sonnet"],
        session_options: { model: "fable", model_source: "explicit" },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "sessions",
        "new",
        "--parent-id",
        "fable-parent",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const childId = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const stored = await readStoredModel(homeDir, childId);

    assert.equal(stored.acpx?.session_options?.model, "opus"); // NOT fable — the invariant
    assert.equal(stored.acpx?.session_options?.model_source, "guard-forced");
    assert.equal(stored.acpx?.session_options?.model_guard?.blocked, "fable");
  });
});

test("R1-sonnet (brick://5bac5564): a bare child of a SONNET parent inherits sonnet (guard fires only on Fable)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "sonnet-parent",
      acpSessionId: "sonnet-parent",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "sonnet",
        available_models: ["fable", "opus", "sonnet"],
        session_options: { model: "sonnet", model_source: "explicit" },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "sessions",
        "new",
        "--parent-id",
        "sonnet-parent",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const childId = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const stored = await readStoredModel(homeDir, childId);

    assert.equal(stored.acpx?.session_options?.model, "sonnet"); // inherited, not touched
    assert.equal(stored.acpx?.session_options?.model_source, "inherited");
    assert.equal(stored.acpx?.session_options?.model_guard, undefined); // guard did not fire
  });
});

test("R2 (brick://5bac5564): an explicit --model fable is preserved (guard does not interfere)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "--model",
        "fable",
        "claude",
        "sessions",
        "new",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const childId = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const stored = await readStoredModel(homeDir, childId);

    assert.equal(stored.acpx?.session_options?.model, "fable"); // explicit request honored
    assert.equal(stored.acpx?.session_options?.model_source, "explicit");
    assert.equal(stored.acpx?.session_options?.model_guard, undefined); // guard did not fire
  });
});

test("R7 (brick://5bac5564): a flagless re-ensure does NOT clobber an explicit --model pin", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "opus-parent",
      acpSessionId: "opus-parent",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "opus",
        available_models: ["fable", "opus", "sonnet"],
        session_options: { model: "opus", model_source: "explicit" },
      },
    });

    // Step 1: create the child with an EXPLICIT --model sonnet off the opus parent.
    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "--model",
        "sonnet",
        "claude",
        "sessions",
        "ensure",
        "-s",
        "r7child",
        "--parent-id",
        "opus-parent",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const childId = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    assert.equal((await readStoredModel(homeDir, childId)).acpx?.session_options?.model, "sonnet");

    // Step 2: a FLAGLESS re-ensure of the SAME session (used to grab the id) — pre-fix
    // this clobbered the pin to the inherited parent model (opus). It must stay sonnet.
    const reensure = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "sessions",
        "ensure",
        "-s",
        "r7child",
        "--parent-id",
        "opus-parent",
      ],
      homeDir,
    );
    assert.equal(reensure.code, 0, reensure.stderr);
    const stored = await readStoredModel(homeDir, childId);

    assert.equal(stored.acpx?.session_options?.model, "sonnet"); // NOT clobbered to opus
    assert.equal(stored.acpx?.session_options?.model_source, "explicit");
  });
});

test("R7-fable (brick://5bac5564): a flagless re-ensure off a Fable parent keeps the explicit opus pin (never becomes fable)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "fable-parent-r7",
      acpSessionId: "fable-parent-r7",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "fable",
        available_models: ["fable", "opus", "sonnet"],
        session_options: { model: "fable", model_source: "explicit" },
      },
    });

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "--model",
        "opus",
        "claude",
        "sessions",
        "ensure",
        "-s",
        "r7fchild",
        "--parent-id",
        "fable-parent-r7",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const childId = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    assert.equal((await readStoredModel(homeDir, childId)).acpx?.session_options?.model, "opus");

    const reensure = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "sessions",
        "ensure",
        "-s",
        "r7fchild",
        "--parent-id",
        "fable-parent-r7",
      ],
      homeDir,
    );
    assert.equal(reensure.code, 0, reensure.stderr);
    const stored = await readStoredModel(homeDir, childId);

    assert.equal(stored.acpx?.session_options?.model, "opus"); // never became fable
    assert.equal(stored.acpx?.session_options?.model_source, "explicit");
  });
});

// brick://ab3bf660 (W7-L12) — an explicit `--model` is a PIN whenever it is
// stated, `sessions new` / a later `prompt` alike. Pre-fix, the apply-belt keyed
// on the RECORD's stored `model_source` ("inherited" from creation) instead of
// THIS invocation's provenance, so a prompt-line `--model fable` was silently
// force-redirected to the non-Fable default while `--reasoning-effort` applied.

test("W7-L12 (c): a prompt-line --model fable PINS fable on an inherited-opus session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    // The reported specimen exactly: a session created with NO --model, whose pin
    // arrived by inheritance (`model_source: "inherited"`).
    await writeSessionRecord(homeDir, {
      acpxRecordId: "l12-inherited",
      acpSessionId: "l12-inherited",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "opus",
        available_models: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
        session_options: { model: "opus", model_source: "inherited" },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "--model",
        "fable",
        "claude",
        "prompt",
        "--session-id",
        "l12-inherited",
        "hi",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const stored = await readStoredModel(homeDir, "l12-inherited");

    assert.equal(stored.acpx?.session_options?.model, "fable"); // the flag PINNED
    assert.equal(stored.acpx?.session_options?.model_source, "explicit");
    assert.equal(stored.acpx?.current_model_id, "fable");
    assert.equal(stored.acpx?.session_options?.model_guard, undefined); // belt did not fire
  });
});

// TURN TWO. A pin that serves one turn and is discarded is not a pin. The specimen
// carried a SECOND defect superimposed on the first: the durable-overlay merge
// reverted the model/provenance written during the turn from the pre-turn disk
// copy, so even the apply-belt's own `guard-forced` write was lost and only its
// `model_guard` breadcrumb (not a durable-overlay field) survived to be seen. A
// single-turn assertion cannot fail on that; this one can.
test("W7-L12 (c2): the explicit pin SURVIVES to turn two — a later flagless prompt keeps fable", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "l12-turn2",
      acpSessionId: "l12-turn2",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "opus",
        available_models: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
        session_options: { model: "opus", model_source: "inherited" },
      },
    });

    // `--ttl 0.01` releases the queue owner right after the turn, so turn two
    // COLD-RESPAWNS. That matters: a warm owner still holds `--model fable` in its
    // spawn-time options and would keep serving fable for that reason alone, which
    // would let this test pass without the pin ever having reached disk. Cold, the
    // only place turn two can learn the pin is the RECORD.
    const turnOne = await runCli(
      [
        "--cwd",
        cwd,
        "--ttl",
        "0.01",
        "--approve-all",
        "--format",
        "json",
        "--model",
        "fable",
        "claude",
        "prompt",
        "--session-id",
        "l12-turn2",
        "one",
      ],
      homeDir,
    );
    assert.equal(turnOne.code, 0, turnOne.stderr);

    // Turn two names NO model. The pin must still be the one turn one set — if the
    // provenance had not persisted as "explicit", the belt would re-block it here
    // and the flag would have worked exactly once.
    const turnTwo = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "prompt",
        "--session-id",
        "l12-turn2",
        "two",
      ],
      homeDir,
    );
    assert.equal(turnTwo.code, 0, turnTwo.stderr);
    const stored = await readStoredModel(homeDir, "l12-turn2");

    assert.equal(stored.acpx?.session_options?.model, "fable");
    assert.equal(stored.acpx?.session_options?.model_source, "explicit");
    assert.equal(stored.acpx?.session_options?.model_guard, undefined); // never re-blocked
  });
});

/**
 * W7-L12 (g) — THE DEFECT IS PROVENANCE-CONDITIONAL, AND THAT IS A TRAP FOR
 * WHOEVER TESTS IT NEXT.
 *
 * ⚠️ DO NOT BUILD A SUBJECT FOR THIS BUG WITH `model_source: "explicit"`.
 * `guardServedModel` returns UNFORCED when `modelSource` is undefined OR
 * "explicit", so a prompt-line `--model fable` was silently overridden ONLY when
 * the target session's stored source was present and NON-explicit (inherited /
 * default / guard-forced). Against an explicitly-pinned session the very same
 * command APPEARED TO WORK before the fix — so a subject built that way
 * reproduces nothing and reads as "there was no bug".
 *
 * This test therefore asserts a property that holds BOTH pre- and post-fix. It
 * earns its place not by failing on the bug but by NAMING the condition, so the
 * suite carries the discriminator instead of leaving it in a report nobody reads.
 * The reproduction subjects are (c) / (c2), which stage `"inherited"`.
 */
test("W7-L12 (g): the override was conditional on NON-explicit stored provenance", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "l12-already-explicit",
      acpSessionId: "l12-already-explicit",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      // The WRONG subject for this bug: stored source already "explicit".
      acpx: {
        current_model_id: "sonnet",
        available_models: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
        session_options: { model: "sonnet", model_source: "explicit" },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "--model",
        "fable",
        "claude",
        "prompt",
        "--session-id",
        "l12-already-explicit",
        "hi",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const stored = await readStoredModel(homeDir, "l12-already-explicit");

    assert.equal(stored.acpx?.session_options?.model, "fable");
    assert.equal(stored.acpx?.session_options?.model_source, "explicit");
    assert.equal(stored.acpx?.session_options?.model_guard, undefined);
  });
});

test("W7-L12 (d): a prompt with NO --model changes nothing on an inherited-opus session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "l12-noflag",
      acpSessionId: "l12-noflag",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "opus",
        available_models: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
        session_options: { model: "opus", model_source: "inherited" },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "prompt",
        "--session-id",
        "l12-noflag",
        "hi",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const stored = await readStoredModel(homeDir, "l12-noflag");

    assert.equal(stored.acpx?.session_options?.model, "opus");
    assert.equal(stored.acpx?.session_options?.model_source, "inherited");
    assert.equal(stored.acpx?.session_options?.model_guard, undefined);
  });
});

test("W7-L12: an IMPLICIT Fable pin on the prompt path is still belt-forced (no --model)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await writeGuardConfig(homeDir);
    // Provenance says the Fable pin was NOT asked for by name → the belt must
    // still redirect it. This is the over-correction guard: the downgrade keys on
    // PROVENANCE, and a non-explicit Fable keeps being downgraded.
    await writeSessionRecord(homeDir, {
      acpxRecordId: "l12-implicit-fable",
      acpSessionId: "l12-implicit-fable",
      agentCommand: GUARD_CLAUDE_COMMAND,
      cwd,
      acpx: {
        current_model_id: "opus",
        available_models: ["fable", "opus", "sonnet"],
        session_options: { model: "fable", model_source: "inherited" },
      },
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--format",
        "json",
        "claude",
        "prompt",
        "--session-id",
        "l12-implicit-fable",
        "hi",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const stored = await readStoredModel(homeDir, "l12-implicit-fable");

    assert.equal(stored.acpx?.session_options?.model, "opus"); // forced off Fable
    assert.equal(stored.acpx?.session_options?.model_guard?.blocked, "fable");
  });
});

/**
 * brick://c327efb5 — RE-PIN AFTER A PER-TURN MODEL SWITCH.
 *
 * The reported defect: a per-turn `--model` moved the LIVE ACP session but left
 * the record's `current_model_id` on the old value. `shouldSkipModelApply`
 * compares the request against that record, so the next `--model <original>` saw
 * "no change", issued NO `session/set_model` at all, and the user was served the
 * PREVIOUS model — exit 0, no warning. Measured on dev@10b5086 with an opus/sonnet
 * control: per-turn set_model counts 1, 1, **0**; wire `opus, sonnet, sonnet`.
 *
 * The drift itself was fixed by W7-L12's `persistChangedModelPin` (742a612) — a
 * fix that landed for a DIFFERENT reason (pin provenance) and never named this
 * property. Nothing tested it, so nothing would have caught it coming back.
 * These two tests name it.
 *
 * ⚠️ ASSERT ON THE `session/set_model` OPS, NOT ON THE STORED RECORD. The record
 * reads `model: opus` at the end of the buggy sequence too — that is exactly the
 * stale value which caused the skip. A record-only assertion passes on the bug.
 * The ops log is the wire: it says what the agent was actually TOLD.
 */
async function writeGuardConfigWithOpLog(homeDir: string, opLog: string): Promise<{ cwd: string }> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  const command = `${GUARD_CLAUDE_COMMAND} --operation-log ${JSON.stringify(opLog)}`;
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
    "utf8",
  );
  return { cwd };
}

async function setModelIdsIssued(opLog: string): Promise<string[]> {
  return (await readMockOperations(opLog))
    .filter((operation) => operation.method === "session/set_model")
    .map((operation) => String(operation.modelId));
}

/** Two prompts on one session, each naming a model. Returns the set_model ops. */
async function runRepinSequence(params: {
  recordId: string;
  pin: string;
  firstModel: string;
  secondModel: string;
}): Promise<string[]> {
  // This file's `withTempHome` returns void (it shadows the generic one in
  // runtime-test-helpers), so the result is captured out rather than returned.
  let issued: string[] = [];
  await withTempHome(async (homeDir) => {
    const opLog = path.join(homeDir, "c327-ops.jsonl");
    const { cwd } = await writeGuardConfigWithOpLog(homeDir, opLog);
    await writeSessionRecord(homeDir, {
      acpxRecordId: params.recordId,
      acpSessionId: params.recordId,
      agentCommand: `${GUARD_CLAUDE_COMMAND} --operation-log ${JSON.stringify(opLog)}`,
      cwd,
      acpx: {
        current_model_id: params.pin,
        available_models: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
        session_options: { model: params.pin, model_source: "explicit" },
      },
    });

    for (const model of [params.firstModel, params.secondModel]) {
      const turn = await runCli(
        [
          "--cwd",
          cwd,
          "--approve-all",
          "--format",
          "json",
          "--model",
          model,
          "claude",
          "prompt",
          "--session-id",
          params.recordId,
          `say ${model}`,
        ],
        homeDir,
      );
      assert.equal(turn.code, 0, turn.stderr);
    }

    issued = await setModelIdsIssued(opLog);
  });
  return issued;
}

test("c327efb5 (a1): re-pinning to the RECORDED model after a per-turn switch still issues set_model", async () => {
  // Session pinned `opus`; turn one switches to `sonnet`; turn two asks for `opus`
  // again. Pre-fix the second turn issued NOTHING and the agent kept serving
  // sonnet. Both switches must reach the agent.
  const issued = await runRepinSequence({
    recordId: "c327-repin-down",
    pin: "opus",
    firstModel: "sonnet",
    secondModel: "opus",
  });

  assert.deepEqual(
    issued,
    ["sonnet", "opus"],
    `expected both switches to reach the agent; got [${issued.join(", ")}]`,
  );
});

test("c327efb5 (a2): the symmetric direction — a session drifted onto the MORE expensive model is re-pinned back down", async () => {
  // The mirror case, and the one that costs money rather than quality: a session
  // pinned `sonnet` is switched up to `opus` for one turn, then asked for `sonnet`
  // again. If that re-pin is skipped, every later turn silently bills at opus
  // while the record reads sonnet. (This is the direction that made the floor
  // code's "the harness only ever downgrades" assumption falsifiable.)
  const issued = await runRepinSequence({
    recordId: "c327-repin-up",
    pin: "sonnet",
    firstModel: "opus",
    secondModel: "sonnet",
  });

  assert.deepEqual(
    issued,
    ["opus", "sonnet"],
    `expected both switches to reach the agent; got [${issued.join(", ")}]`,
  );
});

test("prompting an existing codex session without --model does not reset its model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const operationLog = path.join(homeDir, "codex-existing-ops.jsonl");
    const codexCommand = mockCodexCommand(operationLog, "--supports-load-session");
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "existing-codex",
      acpSessionId: "existing-codex",
      agentCommand: codexCommand,
      cwd,
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--ttl",
        "0.01",
        "--format",
        "quiet",
        "codex",
        "prompt",
        "--session-id",
        "existing-codex",
        "echo existing",
      ],
      homeDir,
      { env: { ACPX_CODEX_ACP_COMMAND: codexCommand } },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /existing/);
    assert.equal(
      (await readMockOperations(operationLog)).some(
        (operation) => operation.method === "session/set_model",
      ),
      false,
    );
  });
});

test("non-codex exec without --model does not apply the codex create-time default", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const operationLog = path.join(homeDir, "non-codex-ops.jsonl");
    const agentCommand = mockCodexCommand(operationLog);
    await fs.mkdir(cwd, { recursive: true });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--approve-all",
        "--agent",
        agentCommand,
        "--format",
        "quiet",
        "exec",
        "echo plain",
      ],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /plain/);
    assert.deepEqual(
      (await readMockOperations(operationLog)).map((operation) => operation.method),
      ["session/new", "session/prompt"],
    );
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

// `parseJsonRpcLines` was removed with the four permission-denial tests above
// (brick a4369a7e) — it had no other caller. See the tombstone for what was lost.

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

function makeBannerRecord(): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "abc123",
    acpSessionId: "abc123",
    agentCommand: "agent-a",
    cwd: "/home/user/project",
    name: "calm-forest",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    closed: false,
  });
}

test("classifyConnectionStatus maps healthy/hasLease to a three-state verdict", () => {
  // healthy → connected (regardless of hasLease)
  assert.equal(classifyConnectionStatus({ healthy: true, hasLease: true }), "connected");
  assert.equal(classifyConnectionStatus({ healthy: true, hasLease: false }), "connected");
  // wedged owner (has a lease but unreachable) → genuine needs-reconnect signal
  assert.equal(classifyConnectionStatus({ healthy: false, hasLease: true }), "needs reconnect");
  // cold spawn (no owner yet) → null ⇒ banner omits the segment
  assert.equal(classifyConnectionStatus({ healthy: false, hasLease: false }), null);
});

test("formatPromptSessionBannerLine omits agent segment on cold spawn (matching cwd)", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(record, "/home/user/project", null);
  assert.equal(line, "[acpx] session calm-forest (abc123) · /home/user/project");
});

test("formatPromptSessionBannerLine omits agent segment on cold spawn (routed-from)", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(record, "/home/user/project/src/auth", null);
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project (routed from ./src/auth)",
  );
});

test("formatPromptSessionBannerLine defaults to cold-spawn (no agent segment)", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(record, "/home/user/project");
  assert.equal(line, "[acpx] session calm-forest (abc123) · /home/user/project");
});

test("formatPromptSessionBannerLine keeps needs-reconnect signal for a wedged owner", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(record, "/home/user/project", "needs reconnect");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project · agent needs reconnect",
  );
});

test("formatPromptSessionBannerLine shows needs-reconnect with routed-from for a wedged owner", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(
    record,
    "/home/user/project/src/auth",
    "needs reconnect",
  );
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project (routed from ./src/auth) · agent needs reconnect",
  );
});

test("formatPromptSessionBannerLine shows connected for a healthy owner", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(record, "/home/user/project", "connected");
  assert.equal(line, "[acpx] session calm-forest (abc123) · /home/user/project · agent connected");
});

test("formatPromptSessionBannerLine shows connected with routed-from for a healthy owner", () => {
  const record = makeBannerRecord();
  const line = formatPromptSessionBannerLine(record, "/home/user/project/src/auth", "connected");
  assert.equal(
    line,
    "[acpx] session calm-forest (abc123) · /home/user/project (routed from ./src/auth) · agent connected",
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
    assert.doesNotMatch(result.stdout, /migrate-messages/);
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
    assert.match(pruneHelp.stdout, /--include-templates/);
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
    // The copy returned 0, so a child session now exists: derive its id before any
    // further assertion and run every one of them inside the try, so the `finally`
    // closes the child on the failure path too — see closeForkedChildSession.
    const childId = String(payload.acpxRecordId);
    try {
      assert.equal(payload.action, "session_copied");
      assert.equal(payload.sourceSessionId, "source-copy");
      assert.equal(payload.forkedAtMessageIndex, messages.length);
      assert.equal(typeof payload.acpxRecordId, "string");
      assert.notEqual(payload.acpxSessionId, payload.agentSessionId);
      assert.match(String(payload.acpxSessionId), /^[0-9a-f-]{36}$/);
      assert.match(String(payload.agentSessionId), /^forked-runtime-/);

      const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
        acp_session_id?: unknown;
        agent_session_id?: unknown;
        agent_command?: unknown;
        cwd?: unknown;
        name?: unknown;
        forked_from_session_id?: unknown;
        forked_at_message_index?: unknown;
        metadata?: Record<string, unknown>;
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
      assert.equal(stored.forked_from_session_id, "source-copy");
      assert.equal(stored.forked_at_message_index, messages.length);
      assert.equal(stored.metadata?.task_folder, "/wisdom/task");
      assert.equal(stored.acpx?.session_options?.subscription, "sub1");
      assert.deepEqual(stored.acpx?.session_options?.allowed_tools, ["Read", "Grep"]);
      assert.equal(stored.acpx?.session_options?.max_turns, 3);
      assert.equal(stored.acpx?.session_options?.system_prompt, "stay on task");
      assert.equal(stored.acpx?.desired_config_options?.effort, "high");
      assert.equal(stored.acpx?.desired_config_options?.custom, "keep-me");

      // #3 Fork notice: reading a message count "right after copy returns" races
      // the deliberately-queued notice turn and trips `3 !== 2` under concurrent
      // load (brick://6b0c1df2). Assert the SETTLED end state instead — never a
      // snapshot mid-delivery. See waitForSettledForkNotice.
      const settledCount = messages.length + 2;
      const settled = await waitForSettledForkNotice(homeDir, childId, messages.length);

      // FW-10 fix: the whole conversation is flushed to the messages-log sidecar
      // (base_index 0), leaving inline `messages` as the split-tail — the fork is
      // stored exactly like its parent. The inherited prefix must survive the
      // notice turn byte-exact, at exactly forkAtMessageIndex entries.
      assert.deepEqual(settled.record.messages, []);
      assert.equal(settled.record.messages_log?.base_index, 0);
      assert.equal(settled.record.messages_log?.count, settledCount);
      assert.deepEqual(settled.log.slice(0, messages.length), messages);

      assertSettledForkNoticeTurn(settled.log, messages.length, "source-copy");

      // last_seq is the fork's OWN event counter: created at 0 (asserted race-free
      // by the notice-free `--ephemeral` sibling below) and advanced only by this
      // fork's own first turn — never carried over from the source's sequence.
      assert.ok(
        typeof settled.record.last_seq === "number" && settled.record.last_seq > 0,
        `expected the notice turn to advance the fork's own last_seq, got ${String(settled.record.last_seq)}`,
      );
    } finally {
      await closeForkedChildSession(homeDir, "codex", childId);
    }
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
    // The copy returned 0, so a child session now exists: derive its id before any
    // further assertion and run every one of them inside the try, so the `finally`
    // closes the child on the failure path too — see closeForkedChildSession.
    const childId = String(payload.acpxRecordId);
    try {
      assert.equal(payload.forkedAtMessageIndex, 0);
      assert.equal(typeof payload.acpxRecordId, "string");

      const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
        forked_from_session_id?: unknown;
        forked_at_message_index?: unknown;
        messages?: unknown[];
      };
      assert.equal(stored.forked_from_session_id, "source-claude-zero");
      assert.equal(stored.forked_at_message_index, 0);
      // Inline `messages` is the split-tail and is empty either side of the notice
      // turn, so this one stays race-free on the immediate read.
      assert.deepEqual(stored.messages, []);

      // #3 Fork notice: `messages_log` is absent only until the deliberately-queued
      // notice turn lands — it then becomes the notice + the fork's reply — so
      // asserting `messages_log === undefined` right after copy returns raced that
      // intended write (brick://5d72f693). Prove the at-index-0 truncation on the
      // SETTLED state instead, and more strongly: the sidecar settles at exactly
      // two entries whose FIRST is the notice, i.e. NOTHING was inherited ahead of
      // it. A fork that wrongly copied the source's two messages would settle at
      // four and fail the wait. See waitForSettledForkNotice.
      const settled = await waitForSettledForkNotice(homeDir, childId, 0);
      assert.deepEqual(settled.record.messages, []);
      assert.equal(settled.record.messages_log?.base_index, 0);
      assert.equal(settled.record.messages_log?.count, 2);
      assert.equal(settled.log.length, 2);

      assertSettledForkNoticeTurn(settled.log, 0, "source-claude-zero");
    } finally {
      await closeForkedChildSession(homeDir, "claude", childId);
    }
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
      messages_log?: { count?: unknown };
    };
    assert.equal(stored.name, "source (fork)");
    assert.equal(stored.kind, "session");
    assert.equal(stored.last_seq, 0);
    assert.equal(stored.forked_from_session_id, "source-truncate");
    assert.equal(stored.forked_at_message_index, 1);
    assert.equal(stored.metadata?.byway, "1");
    assert.equal(stored.metadata?.byway_parent, "source-truncate");
    assert.equal(stored.metadata?.byway_at, "1");
    // FW-10 fix: truncated inherited conversation lives in the messages-log
    // sidecar (count == forkAtMessageIndex == 1), inline `messages` is the
    // split-tail.
    assert.deepEqual(stored.messages, []);
    assert.equal(stored.messages_log?.count, 1);
    assert.deepEqual(
      await readForkMessagesLog(homeDir, String(payload.acpxRecordId)),
      messages.slice(0, 1),
    );
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
    // The copy returned 0, so a child session now exists: derive its id before any
    // further assertion and run every one of them inside the try, so the `finally`
    // closes the child on the failure path too — see closeForkedChildSession.
    const childId = String(payload.acpxRecordId);
    try {
      assert.equal(payload.forkedAtMessageIndex, 2);
      assert.equal(typeof payload.acpxRecordId, "string");

      const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
        cwd?: unknown;
        forked_from_session_id?: unknown;
        forked_at_message_index?: unknown;
        messages?: unknown[];
      };
      assert.equal(stored.cwd, destinationCwd);
      assert.equal(stored.forked_from_session_id, "source-claude-transcript");
      assert.equal(stored.forked_at_message_index, 2);
      // FW-10 fix: inherited conversation flushed to the messages-log sidecar,
      // leaving inline `messages` as the split-tail — empty either side of the
      // notice turn, so this one stays race-free on the immediate read.
      assert.deepEqual(stored.messages, []);

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

      // #3 Fork notice: the sidecar holds the inherited pair only until the
      // deliberately-queued notice turn lands, so asserting `count === 2` and the
      // exact two-entry log right after copy returns raced that intended write and
      // tripped `3 !== 2` under concurrent load (brick://5d72f693). The inherited
      // prefix is proved byte-exact on the SETTLED state instead — at exactly
      // forkAtMessageIndex entries, ahead of the notice. See
      // waitForSettledForkNotice.
      const settledCount = messages.length + 2;
      const settled = await waitForSettledForkNotice(homeDir, childId, messages.length);
      assert.deepEqual(settled.record.messages, []);
      assert.equal(settled.record.messages_log?.base_index, 0);
      assert.equal(settled.record.messages_log?.count, settledCount);
      assert.deepEqual(settled.log.slice(0, messages.length), messages);

      assertSettledForkNoticeTurn(settled.log, messages.length, "source-claude-transcript");
    } finally {
      await closeForkedChildSession(homeDir, "claude", childId);
    }
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
        "--ephemeral",
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
      messages_log?: { count?: unknown };
    };
    assert.equal(stored.acp_session_id, `durable-${sourceAcpSessionId}`);
    assert.equal(stored.agent_session_id, `durable-${sourceAcpSessionId}`);
    assert.equal(stored.cwd, destinationCwd);
    assert.equal(stored.forked_from_session_id, "source-claude-cross-cwd");
    assert.equal(stored.forked_at_message_index, messages.length);
    // FW-10 fix: inherited conversation flushed to the messages-log sidecar.
    assert.deepEqual(stored.messages, []);
    assert.equal(stored.messages_log?.count, messages.length);
    assert.deepEqual(await readForkMessagesLog(homeDir, String(payload.acpxRecordId)), messages);

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

// brick://4dd3ee2c — a claude-pty source copied via the explicit `claude-pty`
// agent must NOT be rejected as a cross-agent copy just because the resolved
// command spelling differs from the one the source was created under. The
// staging repro: source created as `.../acp-server-transcript.mjs` (root shim),
// resolver now yields `.../dist/index.js` (registry default) — the SAME program
// — and the agent-lock's raw-string compare rejected the copy (→ acpx-ui 502).
// Both spellings classify as the claude-pty adapter, so the copy must proceed.
test("sessions copy allows a claude-pty source under a different command spelling", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    // Two DIFFERENT command strings that both classify as claude-pty (the arg
    // substrings `acp-server-transcript` / `claude-pty-acp` are what the adapter
    // detectors match); both are the fork-capable mock so the copy can complete.
    const sourceCommand = `${MOCK_AGENT_WITH_FORK_SESSION} --acp-server-transcript`;
    const pathCommand = `${MOCK_AGENT_WITH_FORK_SESSION} --claude-pty-acp`;
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { "claude-pty": { command: pathCommand } } }, null, 2)}\n`,
      "utf8",
    );
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-pty-spelling",
      acpSessionId: "source-acp-pty-spelling",
      agentCommand: sourceCommand,
      cwd,
      name: "pty-source",
      messages: [{ User: { id: "user-1", content: [{ Text: "hi" }] } }],
      lastSeq: 1,
    });

    const result = await runCli(
      ["--format", "json", "claude-pty", "sessions", "copy", "--from", "source-pty-spelling"],
      homeDir,
    );

    // The agent-lock must NOT fire — that raw-command-string reject is the exact
    // regression under test (pre-fix it exits 1 with this message; post-fix the
    // copy proceeds past the lock, since both spellings are the claude-pty
    // adapter). We assert only the lock behaviour here; the full claude-pty copy
    // needs claude-home profile/home infra a generic mock can't stand up, so
    // completing the copy end-to-end is covered by the browser self-test on a
    // real bridge, not this unit-level CLI test.
    assert.doesNotMatch(
      result.stderr,
      /sessions copy preserves the source agent type/,
      result.stderr,
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

test("sessions new --brick writes record/index, injects env, stamps, and resolves context", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const brickLog = path.join(homeDir, "brick.log");
    const brickPool = path.join(homeDir, "bricks");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(path.join(brickPool, BRICK_X), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--brick", "short-ref"],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "ok",
          BRICK_SHIM_ID: BRICK_X,
          BRICK_SHIM_LOG: brickLog,
          BRICK_SHIM_CONTEXT: "BRICK CONTEXT",
          ACPX_BRICK_POOL_DIR: brickPool,
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
    const childId = String(payload.acpxRecordId);

    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(stored.metadata?.brick, BRICK_X);

    const index = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "sessions", "index.json"), "utf8"),
    ) as { entries?: Array<{ acpxRecordId?: unknown; metadataBrick?: unknown }> };
    assert.equal(
      index.entries?.find((entry) => entry.acpxRecordId === childId)?.metadataBrick,
      BRICK_X,
    );

    const envDump = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(envDump.ACPX_BRICK, BRICK_X);
    assert.equal(envDump.ACPX_BRICK_PATH, path.join(brickPool, BRICK_X));

    const calls = await readJsonl<string[]>(brickLog);
    assert.deepEqual(calls, [
      ["show", "short-ref", "--json"],
      ["context", BRICK_X, "--format", "inject"],
      ["stamp", BRICK_X, "session-started", "--by", `session:${childId}`],
    ]);
  });
});

test("sessions --brick degrades without brick CLI and survives context failure", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const emptyBin = path.join(homeDir, "empty-bin");
    const nodeOnlyBin = await writeNodeOnlyPathBin(homeDir);
    const brickPool = path.join(homeDir, "pool");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(emptyBin, { recursive: true });
    await fs.mkdir(brickPool, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const baseEnv = {
      PATH: `${emptyBin}:${nodeOnlyBin}`,
      ACPX_BRICK_POOL_DIR: brickPool,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    const noPath = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "no-path",
        "--brick",
        BRICK_X.toUpperCase(),
      ],
      homeDir,
      { env: baseEnv },
    );
    assert.equal(noPath.code, 0, noPath.stderr);
    assert.match(noPath.stderr, /accepted unvalidated/);
    assert.match(noPath.stderr, /brick stamp failed/);
    assert.match(noPath.stderr, /brick context unavailable/);
    const noPathId = String(
      (JSON.parse(noPath.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const noPathRecord = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, noPathId), "utf8"),
    ) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(noPathRecord.metadata?.brick, BRICK_X);
    const noPathEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(noPathEnv.ACPX_BRICK, BRICK_X);
    assert.equal(Object.prototype.hasOwnProperty.call(noPathEnv, "ACPX_BRICK_PATH"), false);

    await fs.mkdir(path.join(brickPool, BRICK_X), { recursive: true });
    const withPath = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "with-path",
        "--brick",
        BRICK_X,
      ],
      homeDir,
      { env: baseEnv },
    );
    assert.equal(withPath.code, 0, withPath.stderr);
    const withPathEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<
      string,
      string
    >;
    assert.equal(withPathEnv.ACPX_BRICK, BRICK_X);
    assert.equal(withPathEnv.ACPX_BRICK_PATH, path.join(brickPool, BRICK_X));
  });

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const brickLog = path.join(homeDir, "brick.log");
    const brickPool = path.join(homeDir, "pool");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(path.join(brickPool, BRICK_X), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--brick", "short-ref"],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "ok",
          BRICK_SHIM_ID: BRICK_X,
          BRICK_SHIM_LOG: brickLog,
          BRICK_SHIM_CONTEXT_MODE: "crash",
          ACPX_BRICK_POOL_DIR: brickPool,
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /brick context unavailable/);
    const id = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const record = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(record.metadata?.brick, BRICK_X);
    const envDump = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(envDump.ACPX_BRICK, BRICK_X);
    assert.equal(envDump.ACPX_BRICK_PATH, path.join(brickPool, BRICK_X));
    const calls = await readJsonl<string[]>(brickLog);
    assert.equal(calls.filter((call) => call[0] === "stamp").length, 1);
    assert.deepEqual(
      calls.filter((call) => call[0] === "context"),
      [["context", BRICK_X, "--format", "inject"]],
    );
  });
});

test("sessions new --brick rejects unresolved refs before persistence", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const brickLog = path.join(homeDir, "brick.log");
    const emptyBin = path.join(homeDir, "empty-bin");
    const nodeOnlyBin = await writeNodeOnlyPathBin(homeDir);
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(emptyBin, { recursive: true });
    await writeCodexAgentConfig(
      homeDir,
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))}`,
    );

    const unknown = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--brick", "nope"],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "not-found",
          BRICK_SHIM_LOG: brickLog,
        },
      },
    );
    assert.notEqual(unknown.code, 0);
    assert.match(`${unknown.stdout}\n${unknown.stderr}`, /unknown brick: nope/);
    assert.deepEqual(await listSessionRecordFiles(homeDir), []);

    const ambiguous = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--brick", "dup"],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "ambiguous",
          BRICK_SHIM_LOG: brickLog,
        },
      },
    );
    assert.notEqual(ambiguous.code, 0);
    assert.match(`${ambiguous.stdout}\n${ambiguous.stderr}`, /ambiguous: dup/);
    assert.deepEqual(await listSessionRecordFiles(homeDir), []);

    const missingCliSlug = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--brick", "slug"],
      homeDir,
      {
        env: {
          PATH: `${emptyBin}:${nodeOnlyBin}`,
        },
      },
    );
    assert.notEqual(missingCliSlug.code, 0);
    assert.match(
      `${missingCliSlug.stdout}\n${missingCliSlug.stderr}`,
      /non-uuid refs need the brick CLI/,
    );
    assert.deepEqual(await listSessionRecordFiles(homeDir), []);

    assert.deepEqual(await readJsonl<string[]>(brickLog), [
      ["show", "nope", "--json"],
      ["show", "dup", "--json"],
    ]);
  });
});

test("sessions new inherits parent brick and --no-brick blocks inheritance", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand = `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))}`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "parent-brick",
      acpSessionId: "acp-parent-brick",
      agentName: "codex",
      agentCommand,
      cwd,
      metadata: { brick: BRICK_X },
    });

    const env = {
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_X,
      BRICK_SHIM_LOG: brickLog,
      ACPX_SESSION_URL: "https://test-ui.example/?session=parent-brick",
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    const inherited = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "child"],
      homeDir,
      { env },
    );
    assert.equal(inherited.code, 0, inherited.stderr);
    const inheritedId = String(
      (JSON.parse(inherited.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const inheritedRecord = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, inheritedId), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    assert.equal(inheritedRecord.metadata?.brick, BRICK_X);

    const explicit = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "explicit-child",
        "--brick",
        "other-ref",
      ],
      homeDir,
      { env: { ...env, BRICK_SHIM_ID: BRICK_Z } },
    );
    assert.equal(explicit.code, 0, explicit.stderr);
    const explicitId = String(
      (JSON.parse(explicit.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const explicitRecord = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, explicitId), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    assert.equal(explicitRecord.metadata?.brick, BRICK_Z);

    const blocked = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "blocked-child",
        "--no-brick",
      ],
      homeDir,
      { env },
    );
    assert.equal(blocked.code, 0, blocked.stderr);
    const blockedId = String(
      (JSON.parse(blocked.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const blockedRecord = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, blockedId), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    assert.equal(blockedRecord.metadata?.brick, undefined);

    const calls = await readJsonl<string[]>(brickLog);
    assert.deepEqual(calls, [
      ["context", BRICK_X, "--format", "inject"],
      ["stamp", BRICK_X, "session-started", "--by", `session:${inheritedId}`],
      ["show", "other-ref", "--json"],
      ["context", BRICK_Z, "--format", "inject"],
      ["stamp", BRICK_Z, "session-started", "--by", `session:${explicitId}`],
    ]);
  });
});

test("sessions copy never steals source brick but does inherit the spawn parent's brick", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand = `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} --supports-fork-session`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const source = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "source"],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(source.code, 0, source.stderr);
    const sourceId = String(
      (JSON.parse(source.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    await updateStoredSessionRecord(homeDir, sourceId, (record) => {
      record.metadata = { ...record.metadata, brick: BRICK_X };
    });

    const copy = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        sourceId,
        "--name",
        "copy",
      ],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_LOG: brickLog,
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
      },
    );
    assert.equal(copy.code, 0, copy.stderr);
    const copyId = String(
      (JSON.parse(copy.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const copyRecord = JSON.parse(await fs.readFile(sessionFilePath(homeDir, copyId), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(copyRecord.metadata?.brick, undefined);
    assert.deepEqual(await readJsonlIfExists<string[]>(brickLog), []);
  });

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand = `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} --supports-fork-session`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const parent = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "parent"],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(parent.code, 0, parent.stderr);
    const parentId = String(
      (JSON.parse(parent.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    await updateStoredSessionRecord(homeDir, parentId, (record) => {
      record.metadata = { ...record.metadata, brick: BRICK_X };
    });
    const source = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "source"],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(source.code, 0, source.stderr);
    const sourceId = String(
      (JSON.parse(source.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const copy = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        sourceId,
        "--name",
        "copy",
      ],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "ok",
          BRICK_SHIM_ID: BRICK_X,
          BRICK_SHIM_LOG: brickLog,
          ACPX_SESSION_URL: `https://test-ui.example/?session=${parentId}`,
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
      },
    );
    assert.equal(copy.code, 0, copy.stderr);
    const copyId = String(
      (JSON.parse(copy.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const copyRecord = JSON.parse(await fs.readFile(sessionFilePath(homeDir, copyId), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(copyRecord.metadata?.brick, BRICK_X);
    const stamps = (await readJsonl<string[]>(brickLog)).filter((call) => call[0] === "stamp");
    assert.deepEqual(stamps, [["stamp", BRICK_X, "session-started", "--by", `session:${copyId}`]]);
  });
});

test("sessions ensure --brick stamps create and reuse paths and can re-point the brick", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand = `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))}`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);
    const env = {
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_X,
      BRICK_SHIM_LOG: brickLog,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "--brick", "x"],
      homeDir,
      { env },
    );
    assert.equal(first.code, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout.trim()) as {
      acpxRecordId?: unknown;
      created?: unknown;
    };
    const id = String(firstPayload.acpxRecordId);
    assert.equal(firstPayload.created, true);

    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "--brick", "x"],
      homeDir,
      { env },
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal((JSON.parse(second.stdout.trim()) as { created?: unknown }).created, false);

    const third = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "--brick", "z"],
      homeDir,
      { env: { ...env, BRICK_SHIM_ID: BRICK_Z } },
    );
    assert.equal(third.code, 0, third.stderr);
    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(stored.metadata?.brick, BRICK_Z);

    const stampCalls = (await readJsonl<string[]>(brickLog)).filter((call) => call[0] === "stamp");
    assert.deepEqual(stampCalls, [
      ["stamp", BRICK_X, "session-started", "--by", `session:${id}`],
      ["stamp", BRICK_X, "session-started", "--by", `session:${id}`],
      ["stamp", BRICK_Z, "session-started", "--by", `session:${id}`],
    ]);
  });
});

test("sessions new --from-template --brick preserves template metadata, context, stamp, and auto-prompt", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const operationLog = path.join(homeDir, "codex-acp-ops.jsonl");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand = `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(operationLog)} --supports-fork-session`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const template = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "Template Base"],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(template.code, 0, template.stderr);
    const templateId = String(
      (JSON.parse(template.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const closed = await runCli(
      ["--cwd", cwd, "codex", "sessions", "close", "--session-id", templateId],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(closed.code, 0, closed.stderr);
    const marked = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "template", templateId, "--enable"],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(marked.code, 0, marked.stderr);

    const instantiated = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--from-template",
        templateId,
        "--brick",
        "short-ref",
        "--name",
        "inst",
        "--prompt",
        "TPL AUTO",
      ],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "ok",
          BRICK_SHIM_ID: BRICK_X,
          BRICK_SHIM_LOG: brickLog,
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
        timeoutMs: 60_000,
      },
    );
    assert.equal(instantiated.code, 0, instantiated.stderr);
    const instanceId = String(
      (JSON.parse(instantiated.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const record = JSON.parse(await fs.readFile(sessionFilePath(homeDir, instanceId), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(record.metadata?.brick, BRICK_X);
    assert.equal(record.metadata?.template_source, templateId);

    const calls = await readJsonl<string[]>(brickLog);
    assert.equal(calls.filter((call) => call[0] === "show").length, 1);
    assert.deepEqual(
      calls.filter((call) => call[0] === "context"),
      [["context", BRICK_X, "--format", "inject"]],
    );
    assert.deepEqual(
      calls.filter((call) => call[0] === "stamp"),
      [["stamp", BRICK_X, "session-started", "--by", `session:${instanceId}`]],
    );

    const operations = await waitFor(async () => {
      const entries = await readMockOperations(operationLog);
      return entries.some((entry) => entry.method === "session/prompt") ? entries : null;
    }, 15_000);
    const newIndex = operations.findIndex((entry) => entry.method === "session/new");
    const promptIndex = operations.findIndex(
      (entry) => entry.method === "session/prompt" && entry.text === "TPL AUTO",
    );
    assert.notEqual(newIndex, -1);
    assert.notEqual(promptIndex, -1);
    assert(newIndex < promptIndex);
  });
});

test("raw metadata brick is record-driven for stamp/context; set-metadata validates but does not stamp", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const brickLog = path.join(homeDir, "brick.log");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);
    const env = {
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_X,
      BRICK_SHIM_LOG: brickLog,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };

    const raw = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "raw-brick",
        "--metadata",
        `brick=${BRICK_X}`,
      ],
      homeDir,
      { env },
    );
    assert.equal(raw.code, 0, raw.stderr);
    const rawId = String(
      (JSON.parse(raw.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const noBrick = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "later-brick"],
      homeDir,
      { env },
    );
    assert.equal(noBrick.code, 0, noBrick.stderr);
    const noBrickId = String(
      (JSON.parse(noBrick.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const set = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "set-metadata",
        "--session-id",
        noBrickId,
        "brick",
        BRICK_X.toUpperCase(),
      ],
      homeDir,
      { env },
    );
    assert.equal(set.code, 0, set.stderr);
    const setPayload = JSON.parse(set.stdout.trim()) as { value?: unknown };
    assert.equal(setPayload.value, BRICK_X);

    const bad = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "set-metadata",
        "--session-id",
        noBrickId,
        "brick",
        "not-a-uuid",
      ],
      homeDir,
      { env },
    );
    assert.equal(bad.code, 2);
    const badError = parseSingleAcpErrorLine(bad.stdout);
    assert.equal(badError.code, -32602);
    assert.equal(badError.data?.acpxCode, "USAGE");
    assert.match(badError.message ?? "", /brick must be a full uuid/);

    const prompted = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "prompt", "--session-id", noBrickId, "after set"],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(prompted.code, 0, prompted.stderr);
    const envDump = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(envDump.ACPX_BRICK, BRICK_X);

    const calls = await readJsonl<string[]>(brickLog);
    assert.deepEqual(
      calls.filter((call) => call[0] !== "show"),
      [
        // Create-time render for raw-brick: transient session context (acpxRecordId="") → no --session.
        ["context", BRICK_X, "--format", "inject"],
        ["stamp", BRICK_X, "session-started", "--by", `session:${rawId}`],
        // Prompt-turn render for noBrickId: served by its own owner → renders under its OWN id
        // (fork-identity fix, brick://1113da9d), never the spawner's ambient $ACPX_SESSION_URL.
        ["context", BRICK_X, "--session", noBrickId, "--format", "inject"],
      ],
    );
  });
});

test("external brick and task_folder metadata survives owner turn-end, next prompt, and index rebuild", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const taskDir = path.join(homeDir, "task");
    const operationLog = path.join(homeDir, "codex-acp-ops.jsonl");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand = mockCodexCommand(operationLog);
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(taskDir, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "metadata-race"],
      homeDir,
      { env: { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" } },
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const ownerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_X,
      BRICK_SHIM_LOG: brickLog,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete ownerEnv[key];
    }

    const blocker = spawn(
      process.execPath,
      [
        CLI_PATH,
        "--cwd",
        cwd,
        "--format",
        "quiet",
        "codex",
        "prompt",
        "--session-id",
        id,
        "sleep 4000",
      ],
      {
        env: ownerEnv,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const blockerClosed = new Promise<number | null>((resolve) => {
      blocker.once("close", (code) => resolve(code));
    });

    const expectMetadata = async (label: string): Promise<void> => {
      const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as {
        metadata?: Record<string, unknown>;
      };
      assert.equal(stored.metadata?.brick, BRICK_X, `${label}: brick metadata`);
      assert.equal(stored.metadata?.task_folder, taskDir, `${label}: task_folder metadata`);
    };

    try {
      await waitFor(async () => {
        const operations = await readMockOperations(operationLog);
        return operations.some(
          (entry) => entry.method === "session/prompt" && entry.text === "sleep 4000",
        )
          ? true
          : null;
      }, 10_000);

      const env = {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_ID: BRICK_X,
        BRICK_SHIM_LOG: brickLog,
        ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
      };
      const setBrick = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "codex",
          "sessions",
          "set-metadata",
          "--session-id",
          id,
          "brick",
          BRICK_X,
        ],
        homeDir,
        { env },
      );
      assert.equal(setBrick.code, 0, setBrick.stderr);
      const setTask = await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "codex",
          "sessions",
          "set-metadata",
          "--session-id",
          id,
          "task_folder",
          taskDir,
        ],
        homeDir,
        { env },
      );
      assert.equal(setTask.code, 0, setTask.stderr);

      assert.equal(await blockerClosed, 0);
      await expectMetadata("after owner turn-end");

      const nextPrompt = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "prompt", "--session-id", id, "after merge"],
        homeDir,
        { env, timeoutMs: 60_000 },
      );
      assert.equal(nextPrompt.code, 0, nextPrompt.stderr);
      await expectMetadata("after next prompt");

      const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");
      await fs.rm(indexPath, { force: true });
      const listed = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "--local"],
        homeDir,
        { env },
      );
      assert.equal(listed.code, 0, listed.stderr);
      const rebuiltIndex = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
        entries?: Array<{
          acpxRecordId?: unknown;
          metadataBrick?: unknown;
          metadataTaskFolder?: unknown;
        }>;
      };
      const entry = rebuiltIndex.entries?.find((candidate) => candidate.acpxRecordId === id);
      assert.ok(entry, "rebuilt index entry missing");
      assert.equal(entry.metadataBrick, BRICK_X);
      assert.equal(entry.metadataTaskFolder, taskDir);
    } finally {
      if (blocker.exitCode === null && blocker.signalCode == null) {
        blocker.kill("SIGKILL");
        await blockerClosed;
      }
    }
  });
});

test("brick path wins agent folder while task_folder remains in env", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const brickPool = path.join(homeDir, "pool");
    const taskDir = path.join(homeDir, "taskdir");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(path.join(brickPool, BRICK_X), { recursive: true });
    await fs.mkdir(taskDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const env = {
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_X,
      ACPX_BRICK_POOL_DIR: brickPool,
      ACPX_AGENT_FOLDER: undefined,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "both",
        "--brick",
        "short-ref",
        "--metadata",
        `task_folder=${taskDir}`,
      ],
      homeDir,
      { env },
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const firstEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(firstEnv.ACPX_BRICK, BRICK_X);
    assert.equal(firstEnv.ACPX_BRICK_PATH, path.join(brickPool, BRICK_X));
    assert.equal(firstEnv.ACPX_TASK_FOLDER, taskDir);
    assert.equal(Object.prototype.hasOwnProperty.call(firstEnv, "ACPX_AGENT_FOLDER"), false);

    const prompted = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "prompt", "--session-id", id, "hi"],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(prompted.code, 0, prompted.stderr);
    const secondEnv = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    const expectedAgentFolder = path.join(brickPool, BRICK_X, "agents", `both-${id.slice(0, 8)}`);
    assert.equal(secondEnv.ACPX_AGENT_FOLDER, expectedAgentFolder);
    assert.equal(secondEnv.ACPX_TASK_FOLDER, taskDir);
    await fs.access(expectedAgentFolder);
  });
});

test("stale brick env is deleted when a session has no brick", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "plain"],
      homeDir,
      {
        env: {
          ACPX_BRICK: "stale-brick",
          ACPX_BRICK_PATH: "/stale/brick",
          ACPX_TASK_FOLDER: "/stale/task",
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const envDump = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(Object.prototype.hasOwnProperty.call(envDump, "ACPX_BRICK"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(envDump, "ACPX_BRICK_PATH"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(envDump, "ACPX_TASK_FOLDER"), false);
  });
});

test("empty raw brick metadata blocks inheritance, env injection, stamp, and context", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const envDumpFile = path.join(homeDir, "adapter-env.json");
    const brickLog = path.join(homeDir, "brick.log");
    const agentCommand =
      `${MOCK_AGENT_COMMAND} --operation-log ${JSON.stringify(path.join(homeDir, "codex-acp-ops.jsonl"))} ` +
      `--env-dump-file ${JSON.stringify(envDumpFile)}`;
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, agentCommand);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "parent-empty-brick",
      acpSessionId: "acp-parent-empty-brick",
      agentName: "codex",
      agentCommand,
      cwd,
      metadata: { brick: BRICK_X },
    });

    const child = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "empty-child",
        "--metadata",
        "brick=",
      ],
      homeDir,
      {
        env: {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "ok",
          BRICK_SHIM_ID: BRICK_X,
          BRICK_SHIM_LOG: brickLog,
          ACPX_SESSION_URL: "https://test-ui.example/?session=parent-empty-brick",
          ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
        },
      },
    );
    assert.equal(child.code, 0, child.stderr);
    const childId = String(
      (JSON.parse(child.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const record = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      metadata?: Record<string, unknown>;
    };
    assert.equal(record.metadata?.brick, "");
    const envDump = JSON.parse(await fs.readFile(envDumpFile, "utf8")) as Record<string, string>;
    assert.equal(Object.prototype.hasOwnProperty.call(envDump, "ACPX_BRICK"), false);
    assert.deepEqual(await readJsonlIfExists<string[]>(brickLog), []);
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

async function setupCredentialInheritanceFixture(homeDir: string): Promise<{
  cwd: string;
  claudeCommand: string;
  codexCommand: string;
}> {
  const cwd = path.join(homeDir, "workspace");
  const subscriptionsRoot = path.join(homeDir, ".acpx", "subscriptions");
  const codexHome = path.join(homeDir, ".codex");
  const binDir = path.join(homeDir, "bin");
  const codexCommand = path.join(binDir, "codex-acp");
  const claudeCommand = MOCK_AGENT_COMMAND;

  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(subscriptionsRoot, "sub1"), { recursive: true });
  await fs.mkdir(path.join(subscriptionsRoot, "sub2"), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    codexCommand,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_AGENT_PATH)} "$@"\n`,
    { mode: 0o755 },
  );
  await fs.chmod(codexCommand, 0o755);

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
            id: "chatgpt",
            label: "ChatGPT Codex",
            authMode: "chatgpt",
            adapter: "codex",
            codexHome,
            credentialSource: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify(
      {
        agents: {
          claude: { command: claudeCommand },
          codex: { command: codexCommand },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { cwd, claudeCommand, codexCommand };
}

async function writeClaudeParentWithProfile(
  homeDir: string,
  params: {
    cwd: string;
    claudeCommand: string;
    profile: string;
    id?: string;
  },
): Promise<string> {
  const id = params.id ?? "claude-parent-sub2";
  await writeSessionRecord(homeDir, {
    acpxRecordId: id,
    acpSessionId: id,
    agentCommand: params.claudeCommand,
    cwd: params.cwd,
    acpx: {
      session_options: {
        profile: params.profile,
      },
    },
  });
  return id;
}

async function createChildAndReadRecord(
  homeDir: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await runCli(args, homeDir, { timeoutMs: 8_000 });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
  assert.equal(typeof payload.acpxRecordId, "string");
  return JSON.parse(
    await fs.readFile(sessionFilePath(homeDir, payload.acpxRecordId as string), "utf8"),
  ) as Record<string, unknown>;
}

function sessionOptionsFromRecord(record: Record<string, unknown>): Record<string, unknown> {
  const acpx = record.acpx as { session_options?: Record<string, unknown> } | undefined;
  return acpx?.session_options ?? {};
}

test("codex child of claude parent does not inherit parent profile", async () => {
  await withTempHome(async (homeDir) => {
    const { cwd, claudeCommand, codexCommand } = await setupCredentialInheritanceFixture(homeDir);
    const parentId = await writeClaudeParentWithProfile(homeDir, {
      cwd,
      claudeCommand,
      profile: "sub2",
    });

    const stored = await createChildAndReadRecord(homeDir, [
      "--cwd",
      cwd,
      "--format",
      "json",
      "codex",
      "sessions",
      "new",
      "--parent-id",
      parentId,
    ]);
    const options = sessionOptionsFromRecord(stored);

    assert.equal(stored.parent_session_id, parentId);
    assert.equal(stored.agent_command, codexCommand);
    assert.equal(options.profile, undefined);
    assert.equal(options.subscription, undefined);
  });
});

test("same-agent claude child inherits parent profile when no child credential is explicit", async () => {
  await withTempHome(async (homeDir) => {
    const { cwd, claudeCommand } = await setupCredentialInheritanceFixture(homeDir);
    const parentId = await writeClaudeParentWithProfile(homeDir, {
      cwd,
      claudeCommand,
      profile: "sub2",
    });

    const stored = await createChildAndReadRecord(homeDir, [
      "--cwd",
      cwd,
      "--format",
      "json",
      "claude",
      "sessions",
      "new",
      "--parent-id",
      parentId,
    ]);
    const options = sessionOptionsFromRecord(stored);

    assert.equal(stored.parent_session_id, parentId);
    assert.equal(stored.agent_command, claudeCommand);
    assert.equal(options.profile, "sub2");
  });
});

test("explicit chatgpt profile on codex child is preserved over claude parent profile", async () => {
  await withTempHome(async (homeDir) => {
    const { cwd, claudeCommand, codexCommand } = await setupCredentialInheritanceFixture(homeDir);
    const parentId = await writeClaudeParentWithProfile(homeDir, {
      cwd,
      claudeCommand,
      profile: "sub2",
    });

    const stored = await createChildAndReadRecord(homeDir, [
      "--cwd",
      cwd,
      "--format",
      "json",
      "--profile",
      "chatgpt",
      "codex",
      "sessions",
      "new",
      "--parent-id",
      parentId,
    ]);
    const options = sessionOptionsFromRecord(stored);

    assert.equal(stored.parent_session_id, parentId);
    assert.equal(stored.agent_command, codexCommand);
    assert.equal(options.profile, "chatgpt");
    assert.equal(options.subscription, undefined);
  });
});

test("explicit claude subscription on codex child still rejects as incompatible", async () => {
  await withTempHome(async (homeDir) => {
    const { cwd } = await setupCredentialInheritanceFixture(homeDir);

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "--subscription", "sub2", "codex", "sessions", "new"],
      homeDir,
      { timeoutMs: 8_000 },
    );

    assert.notEqual(result.code, 0);
    const errorPayload = JSON.parse(result.stdout.trim()) as {
      error?: { message?: string };
    };
    const message = errorPayload.error?.message ?? "";
    assert.match(message, /profile "sub2" \(authMode "subscription"\) cannot be used/);
    assert.match(message, /codex adapter\. Use a chatgpt profile for codex auth/);
    assert.deepEqual(await listSessionRecordFiles(homeDir), []);
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

test("generic readable lookup preserves active default-agent precedence over a closed predecessor", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "-s", "recreated"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstId = String(
      (JSON.parse(first.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "-s", "recreated"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondId = String(
      (JSON.parse(second.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    assert.notEqual(secondId, firstId);

    const firstRecord = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, firstId), "utf8"),
    ) as { closed?: unknown };
    assert.equal(firstRecord.closed, true);

    const shown = await runCli(
      ["--cwd", cwd, "--format", "json", "sessions", "show", "recreated"],
      homeDir,
    );
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(
      (JSON.parse(shown.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      secondId,
    );
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

test("explicit selectors stay global and a unique explicit name resolves across cwd", async () => {
  await withTempHome(async (homeDir) => {
    const sessionCwd = path.join(homeDir, "workspace", "project");
    const otherCwd = path.join(homeDir, "elsewhere");
    const archivePath = path.join(homeDir, "selector-export.json");
    const recordId = "33333333-3333-4333-8333-333333333333";
    const acpSessionId = "44444444-4444-4444-8444-444444444444";
    const sessionUrl = `https://acpx.devbox.nativai.de/?session=${recordId}`;
    const messages: SessionRecord["messages"] = [
      { User: { id: "user-1", content: [{ Text: "selector user text" }] } },
      { Agent: { content: [{ Text: "selector assistant text" }], tool_results: {} } },
    ];
    await fs.mkdir(sessionCwd, { recursive: true });
    await fs.mkdir(otherCwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: recordId,
      acpSessionId,
      agentCommand: AGENT_REGISTRY.codex,
      cwd: sessionCwd,
      name: "mutable-label",
      messages,
      lastSeq: messages.length,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
      acpx: {
        current_model_id: "default",
        available_models: ["default", "opus"],
        desired_config_options: { effort: "max" },
        config_options: [
          {
            id: "effort",
            name: "Effort",
            type: "select",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
              { value: "max", name: "Max" },
            ],
          },
        ],
      },
    });

    const wrongCwdNameStatus = await runCli(
      ["--cwd", otherCwd, "--format", "json", "codex", "status", "-s", "mutable-label"],
      homeDir,
    );
    assert.equal(wrongCwdNameStatus.code, 0, wrongCwdNameStatus.stderr);
    const wrongCwdNamePayload = JSON.parse(wrongCwdNameStatus.stdout.trim()) as {
      acpxRecordId?: unknown;
    };
    assert.equal(wrongCwdNamePayload.acpxRecordId, recordId);

    const correctCwdNameStatus = await runCli(
      ["--cwd", sessionCwd, "--format", "json", "codex", "status", "-s", "mutable-label"],
      homeDir,
    );
    assert.equal(correctCwdNameStatus.code, 0, correctCwdNameStatus.stderr);
    const correctCwdNamePayload = JSON.parse(correctCwdNameStatus.stdout.trim()) as {
      acpxRecordId?: unknown;
    };
    assert.equal(correctCwdNamePayload.acpxRecordId, recordId);

    const statusByUrl = await runCli(
      ["--cwd", otherCwd, "--format", "json", "codex", "status", "--session-url", sessionUrl],
      homeDir,
    );
    assert.equal(statusByUrl.code, 0, statusByUrl.stderr);
    const statusByUrlPayload = JSON.parse(statusByUrl.stdout.trim()) as {
      acpxRecordId?: unknown;
      model?: unknown;
      availableModels?: unknown;
      reasoningEffort?: unknown;
      reasoningEffortLive?: unknown;
    };
    assert.equal(statusByUrlPayload.acpxRecordId, recordId);
    assert.equal(statusByUrlPayload.model, "default");
    assert.deepEqual(statusByUrlPayload.availableModels, ["default", "opus"]);
    assert.equal(statusByUrlPayload.reasoningEffort, "max");
    assert.equal(statusByUrlPayload.reasoningEffortLive, "high");

    const statusByIdSuffix = await runCli(
      ["--cwd", otherCwd, "--format", "json", "codex", "status", "--session-id", "333333333333"],
      homeDir,
    );
    assert.equal(statusByIdSuffix.code, 0, statusByIdSuffix.stderr);
    const statusByIdSuffixPayload = JSON.parse(statusByIdSuffix.stdout.trim()) as {
      acpxRecordId?: unknown;
      reasoningEffort?: unknown;
    };
    assert.equal(statusByIdSuffixPayload.acpxRecordId, recordId);
    assert.equal(statusByIdSuffixPayload.reasoningEffort, "max");

    const showByUrl = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "show",
        "--session-url",
        sessionUrl,
      ],
      homeDir,
    );
    assert.equal(showByUrl.code, 0, showByUrl.stderr);
    const shown = JSON.parse(showByUrl.stdout.trim()) as SessionRecord;
    assert.equal(shown.acpxRecordId, recordId);
    assert.equal(shown.cwd, sessionCwd);

    const readByIdSuffix = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "read",
        "--session-id",
        "333333333333",
      ],
      homeDir,
    );
    assert.equal(readByIdSuffix.code, 0, readByIdSuffix.stderr);
    const readPayload = JSON.parse(readByIdSuffix.stdout.trim()) as {
      id?: unknown;
      entries?: Array<{ textPreview?: unknown }>;
    };
    assert.equal(readPayload.id, recordId);
    assert.deepEqual(
      readPayload.entries?.map((entry) => entry.textPreview),
      ["selector user text", "selector assistant text"],
    );

    const historyByUrl = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "history",
        "--session-url",
        sessionUrl,
        "--limit",
        "1",
      ],
      homeDir,
    );
    assert.equal(historyByUrl.code, 0, historyByUrl.stderr);
    const historyPayload = JSON.parse(historyByUrl.stdout.trim()) as {
      id?: unknown;
      count?: unknown;
      entries?: Array<{ textPreview?: unknown }>;
    };
    assert.equal(historyPayload.id, recordId);
    assert.equal(historyPayload.count, 1);
    assert.deepEqual(
      historyPayload.entries?.map((entry) => entry.textPreview),
      ["selector assistant text"],
    );

    const metadataByUrl = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "set-metadata",
        "--session-url",
        sessionUrl,
        "owner",
        "uuid-selector",
      ],
      homeDir,
    );
    assert.equal(metadataByUrl.code, 0, metadataByUrl.stderr);
    const storedAfterMetadata = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, recordId), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    assert.equal(storedAfterMetadata.metadata?.owner, "uuid-selector");

    const exportedByUrl = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "quiet",
        "codex",
        "sessions",
        "export",
        "--session-url",
        sessionUrl,
        "--output",
        archivePath,
      ],
      homeDir,
    );
    assert.equal(exportedByUrl.code, 0, exportedByUrl.stderr);
    assert.equal(exportedByUrl.stdout.trim(), archivePath);
    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { record_id?: unknown; cwd_original?: unknown };
    };
    assert.equal(archive.session?.record_id, recordId);
    assert.equal(archive.session?.cwd_original, "workspace/project");

    const closeById = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "close",
        "--session-id",
        recordId,
      ],
      homeDir,
    );
    assert.equal(closeById.code, 0, closeById.stderr);
    const closePayload = JSON.parse(closeById.stdout.trim()) as {
      action?: unknown;
      acpxRecordId?: unknown;
    };
    assert.equal(closePayload.action, "session_closed");
    assert.equal(closePayload.acpxRecordId, recordId);
  });
});

test("explicit names preserve routed ancestor and exact-cwd local precedence", async () => {
  await withTempHome(async (homeDir) => {
    const repoRoot = path.join(homeDir, "workspace", "repo");
    const childCwd = path.join(repoRoot, "packages", "app");
    const remoteCwd = path.join(homeDir, "workspace", "remote");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(childCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "ancestor-shared",
      acpSessionId: "ancestor-shared",
      agentName: "codex",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: repoRoot,
      name: "shared-local",
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "remote-shared",
      acpSessionId: "remote-shared",
      agentName: "codex",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: remoteCwd,
      name: "shared-local",
    });

    const routed = await runCli(
      [
        "--cwd",
        childCwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "set-metadata",
        "-s",
        "shared-local",
        "owner",
        "ancestor",
      ],
      homeDir,
    );
    assert.equal(routed.code, 0, routed.stderr);
    const ancestor = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "ancestor-shared"), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    assert.equal(ancestor.metadata?.owner, "ancestor");

    const exactScopedMiss = await runCli(
      ["--cwd", childCwd, "codex", "status", "-s", "shared-local"],
      homeDir,
    );
    assert.equal(exactScopedMiss.code, 1);
    assert.match(exactScopedMiss.stderr, /ambiguous/i);
    assert.match(exactScopedMiss.stderr, /cwd: .*workspace\/repo; record ID: ancestor-shared/);
    assert.match(exactScopedMiss.stderr, /cwd: .*workspace\/remote; record ID: remote-shared/);
    assert.match(exactScopedMiss.stderr, /--session-id <id>/);
    assert.match(exactScopedMiss.stderr, /--session-url <url>/);

    await writeSessionRecord(homeDir, {
      acpxRecordId: "exact-shared",
      acpSessionId: "exact-shared",
      agentName: "codex",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: childCwd,
      name: "shared-local",
    });
    const exactLocal = await runCli(
      ["--cwd", childCwd, "--format", "json", "codex", "status", "-s", "shared-local"],
      homeDir,
    );
    assert.equal(exactLocal.code, 0, exactLocal.stderr);
    const exactPayload = JSON.parse(exactLocal.stdout.trim()) as { acpxRecordId?: unknown };
    assert.equal(exactPayload.acpxRecordId, "exact-shared");
  });
});

test("global explicit-name fallback is agent-scoped and command eligibility stays intact", async () => {
  await withTempHome(async (homeDir) => {
    const sessionCwd = path.join(homeDir, "workspace", "project-a");
    const callerCwd = path.join(homeDir, "workspace", "project-b");
    const otherAgentCwd = path.join(homeDir, "workspace", "project-c");
    const archivePath = path.join(homeDir, "closed-export.json");
    await fs.mkdir(sessionCwd, { recursive: true });
    await fs.mkdir(callerCwd, { recursive: true });
    await fs.mkdir(otherAgentCwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "codex-global",
      acpSessionId: "codex-global",
      agentName: "codex",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: sessionCwd,
      name: "agent-scoped",
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "claude-global",
      acpSessionId: "claude-global",
      agentName: "claude",
      agentCommand: AGENT_REGISTRY.claude,
      cwd: otherAgentCwd,
      name: "agent-scoped",
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "closed-global",
      acpSessionId: "closed-global",
      agentName: "codex",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: sessionCwd,
      name: "closed-readable",
      closed: true,
      closedAt: "2026-01-02T00:00:00.000Z",
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "unnamed-global",
      acpSessionId: "unnamed-global",
      agentName: "codex",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: sessionCwd,
    });

    const agentScoped = await runCli(
      ["--cwd", callerCwd, "--format", "json", "codex", "status", "-s", "agent-scoped"],
      homeDir,
    );
    assert.equal(agentScoped.code, 0, agentScoped.stderr);
    assert.equal(
      (JSON.parse(agentScoped.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      "codex-global",
    );

    const closedStatus = await runCli(
      ["--cwd", callerCwd, "--format", "json", "codex", "status", "-s", "closed-readable"],
      homeDir,
    );
    assert.equal(closedStatus.code, 0, closedStatus.stderr);
    assert.equal(
      (JSON.parse(closedStatus.stdout.trim()) as { status?: unknown }).status,
      "no-session",
    );

    const closedShow = await runCli(
      ["--cwd", callerCwd, "--format", "json", "codex", "sessions", "show", "closed-readable"],
      homeDir,
    );
    assert.equal(closedShow.code, 0, closedShow.stderr);
    assert.equal(
      (JSON.parse(closedShow.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      "closed-global",
    );

    const closedExport = await runCli(
      [
        "--cwd",
        callerCwd,
        "--format",
        "quiet",
        "codex",
        "sessions",
        "export",
        "closed-readable",
        "--output",
        archivePath,
      ],
      homeDir,
    );
    assert.equal(closedExport.code, 0, closedExport.stderr);
    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { record_id?: unknown };
    };
    assert.equal(archive.session?.record_id, "closed-global");

    const omittedDefault = await runCli(
      ["--cwd", callerCwd, "--format", "json", "codex", "status"],
      homeDir,
    );
    assert.equal(omittedDefault.code, 0, omittedDefault.stderr);
    assert.equal(
      (JSON.parse(omittedDefault.stdout.trim()) as { status?: unknown }).status,
      "no-session",
    );

    const missingExplicit = await runCli(
      ["--cwd", callerCwd, "codex", "prompt", "-s", "does-not-exist", "hello"],
      homeDir,
    );
    assert.equal(missingExplicit.code, 4);
    assert.match(missingExplicit.stderr, /No acpx session found/);
  });
});

test("sessions ensure and new keep explicit names scoped to their creation cwd", async () => {
  await withTempHome(async (homeDir) => {
    const cwdA = path.join(homeDir, "workspace", "project-a");
    const cwdB = path.join(homeDir, "workspace", "project-b");
    const cwdC = path.join(homeDir, "workspace", "project-c");
    await fs.mkdir(cwdA, { recursive: true });
    await fs.mkdir(cwdB, { recursive: true });
    await fs.mkdir(cwdC, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "existing-reusable",
      acpSessionId: "existing-reusable",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd: cwdA,
      name: "implementation",
    });

    const ensured = await runCli(
      ["--cwd", cwdB, "--format", "json", "codex", "sessions", "ensure", "-s", "implementation"],
      homeDir,
    );
    assert.equal(ensured.code, 0, ensured.stderr);
    const ensuredPayload = JSON.parse(ensured.stdout.trim()) as {
      acpxRecordId?: string;
      created?: boolean;
    };
    assert.equal(ensuredPayload.created, true);
    assert.notEqual(ensuredPayload.acpxRecordId, "existing-reusable");
    const ensuredRecord = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, ensuredPayload.acpxRecordId ?? ""), "utf8"),
    ) as { cwd?: string };
    assert.equal(ensuredRecord.cwd, cwdB);

    const created = await runCli(
      ["--cwd", cwdC, "--format", "json", "codex", "sessions", "new", "-s", "implementation"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout.trim()) as {
      acpxRecordId?: string;
      created?: boolean;
    };
    assert.equal(createdPayload.created, true);
    assert.notEqual(createdPayload.acpxRecordId, "existing-reusable");
    assert.notEqual(createdPayload.acpxRecordId, ensuredPayload.acpxRecordId);

    const original = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "existing-reusable"), "utf8"),
    ) as { closed?: boolean };
    assert.equal(original.closed, false);
  });
});

test("prompt resolves a unique explicit name across cwd boundaries", async () => {
  await withTempHome(async (homeDir) => {
    const sessionCwd = path.join(homeDir, "workspace", "project-a");
    const callerCwd = path.join(homeDir, "workspace", "project-b");
    await fs.mkdir(sessionCwd, { recursive: true });
    await fs.mkdir(callerCwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID);

    const created = await runCli(
      ["--cwd", sessionCwd, "--format", "json", "codex", "sessions", "new", "-s", "infra-deploy"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const sessionId = (JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
    assert.equal(typeof sessionId, "string");

    const prompt = await runCli(
      [
        "--cwd",
        callerCwd,
        "--format",
        "quiet",
        "codex",
        "prompt",
        "-s",
        "infra-deploy",
        "echo cross-cwd-name-success",
      ],
      homeDir,
    );
    assert.equal(prompt.code, 0, prompt.stderr);
    assert.match(prompt.stdout, /cross-cwd-name-success/);

    const close = await runCli(
      ["--cwd", callerCwd, "codex", "sessions", "close", "--session-id", sessionId ?? ""],
      homeDir,
    );
    assert.equal(close.code, 0, close.stderr);
  });
});

test("explicit session selectors reject ambiguous name and id combinations", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "selector-conflict",
      acpSessionId: "selector-conflict",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      name: "label",
    });

    const nameAndId = await runCli(
      ["--cwd", cwd, "codex", "status", "-s", "label", "--session-id", "selector-conflict"],
      homeDir,
    );
    assert.notEqual(nameAndId.code, 0);
    assert.match(nameAndId.stderr, /session name.*--session-id\/--session-url/i);

    const positionalAndUrl = await runCli(
      [
        "--cwd",
        cwd,
        "codex",
        "sessions",
        "show",
        "label",
        "--session-url",
        "https://acpx.devbox.nativai.de/?session=selector-conflict",
      ],
      homeDir,
    );
    assert.notEqual(positionalAndUrl.code, 0);
    assert.match(positionalAndUrl.stderr, /session name.*--session-id\/--session-url/i);

    const idAndUrl = await runCli(
      [
        "--cwd",
        cwd,
        "codex",
        "sessions",
        "show",
        "--session-id",
        "selector-conflict",
        "--session-url",
        "https://acpx.devbox.nativai.de/?session=selector-conflict",
      ],
      homeDir,
    );
    assert.notEqual(idAndUrl.code, 0);
    assert.match(idAndUrl.stderr, /only one of --session-id or --session-url/i);

    const invalidUrl = await runCli(
      [
        "--cwd",
        cwd,
        "codex",
        "sessions",
        "show",
        "--session-url",
        "https://acpx.devbox.nativai.de/",
      ],
      homeDir,
    );
    assert.notEqual(invalidUrl.code, 0);
    assert.match(invalidUrl.stderr, /must include.*\?session=<id>/i);
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

test("explicit session selectors route prompt and live control commands globally", async () => {
  await withTempHome(async (homeDir) => {
    const sessionCwd = path.join(homeDir, "workspace", "live-session");
    const otherCwd = path.join(homeDir, "outside-live-session");
    const sessionId = "live-selector-session";
    const sessionUrl = `https://acpx.devbox.nativai.de/?session=${sessionId}`;
    await fs.mkdir(sessionCwd, { recursive: true });
    await fs.mkdir(otherCwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID);
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: MOCK_AGENT_WITH_LOAD_RUNTIME_SESSION_ID,
      cwd: sessionCwd,
      name: "live-label",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const barePrompt = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "quiet",
        "codex",
        "--session-url",
        sessionUrl,
        "echo bare-selector",
      ],
      homeDir,
    );
    assert.equal(barePrompt.code, 0, barePrompt.stderr);
    assert.match(barePrompt.stdout, /bare-selector/);

    const promptSubcommand = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "quiet",
        "codex",
        "prompt",
        "--session-id",
        sessionId,
        "echo subcommand-selector",
      ],
      homeDir,
    );
    assert.equal(promptSubcommand.code, 0, promptSubcommand.stderr);
    assert.match(promptSubcommand.stdout, /subcommand-selector/);

    const cancelByUrl = await runCli(
      ["--cwd", otherCwd, "codex", "cancel", "--session-url", sessionUrl],
      homeDir,
    );
    assert.equal(cancelByUrl.code, 0, cancelByUrl.stderr);
    assert.match(cancelByUrl.stdout, /nothing to cancel/);

    const setModeById = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "set-mode",
        "--session-id",
        sessionId,
        "plan",
      ],
      homeDir,
    );
    assert.equal(setModeById.code, 0, setModeById.stderr);
    const setModePayload = JSON.parse(setModeById.stdout.trim()) as {
      action?: unknown;
      acpxRecordId?: unknown;
      modeId?: unknown;
    };
    assert.equal(setModePayload.action, "mode_set");
    assert.equal(setModePayload.acpxRecordId, sessionId);
    assert.equal(setModePayload.modeId, "plan");

    const setConfigByUrl = await runCli(
      [
        "--cwd",
        otherCwd,
        "--format",
        "json",
        "codex",
        "set",
        "--session-url",
        sessionUrl,
        "reasoning_effort",
        "high",
      ],
      homeDir,
    );
    assert.equal(setConfigByUrl.code, 0, setConfigByUrl.stderr);
    const setConfigPayload = JSON.parse(setConfigByUrl.stdout.trim()) as {
      action?: unknown;
      acpxRecordId?: unknown;
      configId?: unknown;
      value?: unknown;
    };
    assert.equal(setConfigPayload.action, "config_set");
    assert.equal(setConfigPayload.acpxRecordId, sessionId);
    assert.equal(setConfigPayload.configId, "reasoning_effort");
    assert.equal(setConfigPayload.value, "high");
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

test("set auto-failover updates durable policy and status json reports it", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionId = "set-auto-failover-cli";
    await writeSessionRecord(homeDir, {
      acpxRecordId: sessionId,
      acpSessionId: `${sessionId}-acp`,
      agentSessionId: `${sessionId}-agent`,
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    const setOff = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "set",
        "auto-failover",
        "off",
        "--session-id",
        sessionId,
      ],
      homeDir,
    );
    assert.equal(setOff.code, 0, setOff.stderr);
    const setPayload = JSON.parse(setOff.stdout.trim()) as Record<string, unknown>;
    assert.equal(setPayload.action, "auto_failover_set");
    assert.equal(setPayload.autoFailover, false);
    assert.equal(setPayload.acpxRecordId, sessionId);
    assert.equal(setPayload.acpxSessionId, `${sessionId}-acp`);
    assert.equal(setPayload.agentSessionId, `${sessionId}-agent`);

    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, sessionId), "utf8")) as {
      acpx?: { session_options?: { auto_failover?: unknown } };
    };
    assert.equal(stored.acpx?.session_options?.auto_failover, false);

    const status = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "status", "--session-id", sessionId],
      homeDir,
    );
    assert.equal(status.code, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout.trim()) as Record<string, unknown>;
    assert.equal(statusPayload.action, "status_snapshot");
    assert.equal(statusPayload.autoFailover, false);
  });
});

test("status reports auto_failover:off for a DIFFERENT session read cross-session by id and url", async () => {
  await withTempHome(async (homeDir) => {
    const sessionCwd = path.join(homeDir, "workspace", "project");
    const otherCwd = path.join(homeDir, "elsewhere");
    await fs.mkdir(sessionCwd, { recursive: true });
    await fs.mkdir(otherCwd, { recursive: true });
    const recordId = "55555555-5555-4555-8555-555555555555";
    const sessionUrl = `https://acpx.devbox.nativai.de/?session=${recordId}`;

    // A session that has explicitly disabled failover, persisted on its record.
    await writeSessionRecord(homeDir, {
      acpxRecordId: recordId,
      acpSessionId: `${recordId}-acp`,
      agentCommand: AGENT_REGISTRY.codex,
      cwd: sessionCwd,
      name: "failover-off-session",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
      acpx: { session_options: { auto_failover: false } },
    });

    // Cross-session read from an UNRELATED cwd (not the session's own) by id.
    const statusById = await runCli(
      ["--cwd", otherCwd, "--format", "json", "codex", "status", "--session-id", recordId],
      homeDir,
    );
    assert.equal(statusById.code, 0, statusById.stderr);
    const byIdPayload = JSON.parse(statusById.stdout.trim()) as Record<string, unknown>;
    assert.equal(byIdPayload.acpxRecordId, recordId);
    // The brick's literal claim: the OTHER session's policy is reported, not omitted.
    assert.equal(byIdPayload.autoFailover, false);

    // And by url selector, same result.
    const statusByUrl = await runCli(
      ["--cwd", otherCwd, "--format", "json", "codex", "status", "--session-url", sessionUrl],
      homeDir,
    );
    assert.equal(statusByUrl.code, 0, statusByUrl.stderr);
    const byUrlPayload = JSON.parse(statusByUrl.stdout.trim()) as Record<string, unknown>;
    assert.equal(byUrlPayload.acpxRecordId, recordId);
    assert.equal(byUrlPayload.autoFailover, false);

    // Text surface too, so a human `status` read is unambiguous.
    const statusText = await runCli(
      ["--cwd", otherCwd, "codex", "status", "--session-id", recordId],
      homeDir,
    );
    assert.equal(statusText.code, 0, statusText.stderr);
    assert.match(statusText.stdout, /autoFailover: off/);
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

// ── REMOVED BY brick a4369a7e — four tests whose TRIGGER no longer exists ────
//
// `queued prompt failures emit exactly one JSON error event`, its `--json-strict`
// and `quiet` siblings, and `non-queued write permission denial exits with code 5`
// all provoked their failure with a PERMISSION DENIAL (`--deny-all`, or
// `--approve-reads` + `--non-interactive-permissions fail` reaching an
// unavailable prompt). a4369a7e enforces approve-all at the policy source, so no
// flag reduces permissions at any surface and `EXIT_CODES.PERMISSION_DENIED` is
// unreachable BY DESIGN. There is no drop-in replacement: four alternative
// triggers were measured and none reproduces the same error class —
//   • write outside the cwd subtree → a TOOL failure; the turn ends normally, rc 0
//   • malformed `write` (mock-side throw) → rc 0
//   • `disconnect 10` (agent dies mid-prompt) → rc 1, but NO json error event
//   • a depth-1 queue → the prompt was still accepted, rc 0
//
// WHAT WAS LOST, named rather than quietly dropped: the CLI-level end-to-end
// assertion that a failed QUEUED prompt emits its error EXACTLY ONCE, with a real
// sessionId, in each of the three output formats. The single-emission rule itself
// retains coverage (`test/queue-ipc-server.test.ts`,
// `test/persist-exhausted-stream-error.test.ts`, and `queueErrorAlreadyEmitted`
// in `test/cli-flags.test.ts`); what is gone is the format-by-format CLI shape.
// Re-homing it needs a queued prompt that genuinely fails, which the mock agent
// does not currently make reachable. Reported to WS-core 2026-09-04.
//
// The property that REPLACES them lives in `test/permission-property.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

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

test("prompt resolves named session across session flag placements (upstream 0035ef3 / #355)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });

    const missingAgentCommand = "acpx-test-missing-agent-binary-3";
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
      acpxRecordId: "named-prompt-session",
      acpSessionId: "named-prompt-session",
      agentCommand: missingAgentCommand,
      cwd,
      name: "named",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      closed: false,
    });

    // -s / --session must resolve the same named session whether it appears
    // before OR after the `prompt` subcommand. (Our fork already routes prompt
    // through the parent-aware resolveSessionTargetSelector; this locks it in.)
    const cases = [
      ["codex", "-s", "named", "prompt", "ping"],
      ["codex", "--session", "named", "prompt", "ping"],
      ["codex", "prompt", "-s", "named", "ping"],
      ["codex", "prompt", "--session", "named", "ping"],
    ];

    for (const args of cases) {
      const result = await runCli(["--cwd", cwd, ...args], homeDir);

      // Session was resolved regardless of flag placement — failure is the
      // missing agent binary downstream, not a lookup miss.
      assert.equal(result.code, 1, args.join(" "));
      assert.doesNotMatch(result.stderr, /No acpx session found/, args.join(" "));
    }
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

// ─── brick://a62de399: prune must not silently delete a template blueprint ────
test("sessions prune skips template blueprints and says so per skip", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "tmpl-blueprint",
      acpSessionId: "tmpl-blueprint",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: true,
      closedAt: "2026-01-01T00:10:00.000Z",
      template: {
        enabled: true,
        slug: "telegram-personal-assistant",
        version: 1,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });
    await writeSessionRecord(homeDir, {
      acpxRecordId: "tmpl-plain-closed",
      acpSessionId: "tmpl-plain-closed",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: true,
      closedAt: "2026-01-01T00:10:00.000Z",
    });

    // --cwd added by brick://dd4cb0e8: a destructive prune now requires a scope,
    // so the bare form this test used is refused (exit 2, nothing deleted). The
    // template behaviour under test is unchanged.
    const result = await runCli(["--cwd", cwd, "codex", "sessions", "prune", "--cwd"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    // brick://dd4cb0e8 (O8): LINE-ANCHORED, and it must stay that way. The previous
    // unanchored form `/skipped tmpl-blueprint — template '…'/` matched BOTH the old
    // wording and the new one, because the new string contains the old substring —
    // so it would have stayed green without ever verifying the token-carrying form,
    // and a revert to the old wording would go undetected. This pins the `prune `
    // prefix and the two-space indent, which is what makes it able to see the change
    // it guards.
    assert.match(
      result.stdout,
      /^ {2}prune skipped tmpl-blueprint — template 'telegram-personal-assistant'$/m,
    );
    assert.match(result.stdout, /Pruned 1 session/);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "tmpl-plain-closed"))));
    assert.ok(await fileExists(sessionFilePath(homeDir, "tmpl-blueprint")));

    // The opt-in is the only way through, and it deletes the blueprint.
    // (--include-templates WIDENS what a scope selects; it is not itself a scope.)
    const forced = await runCli(
      ["--cwd", cwd, "codex", "sessions", "prune", "--cwd", "--include-templates"],
      homeDir,
    );

    assert.equal(forced.code, 0, forced.stderr);
    assert.doesNotMatch(forced.stdout, /skipped tmpl-blueprint/);
    assert.match(forced.stdout, /Pruned 1 session/);
    assert.ok(!(await fileExists(sessionFilePath(homeDir, "tmpl-blueprint"))));
  });
});

test("sessions prune reports skipped templates in json output", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    await writeSessionRecord(homeDir, {
      acpxRecordId: "tmpl-json-bp",
      acpSessionId: "tmpl-json-bp",
      agentCommand: AGENT_REGISTRY.codex,
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:10:00.000Z",
      closed: true,
      closedAt: "2026-01-01T00:10:00.000Z",
      template: {
        enabled: true,
        slug: "intaker",
        version: 7,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });

    // --cwd added by brick://dd4cb0e8 — a destructive prune requires a scope.
    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "prune", "--cwd"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      count?: number;
      pruned?: string[];
      skippedTemplates?: { acpxRecordId: string; slug: string }[];
    };
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.skippedTemplates, [{ acpxRecordId: "tmpl-json-bp", slug: "intaker" }]);
    assert.ok(await fileExists(sessionFilePath(homeDir, "tmpl-json-bp")));
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

    // --cwd added by brick://dd4cb0e8. --include-history is NOT a scope: it widens
    // what a scope deletes (the stream files too), so it still needs one.
    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "prune",
        "--cwd",
        "--include-history",
      ],
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

async function writeNodeOnlyPathBin(homeDir: string): Promise<string> {
  const binDir = path.join(homeDir, "node-only-bin");
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(process.execPath, path.join(binDir, "node"));
  return binDir;
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
      // ⚠️ ACPX_STATE_HOME must be pinned alongside HOME, not merely left alone.
      // `sessionBaseDir()` reads `process.env.ACPX_STATE_HOME || os.homedir()`, so
      // it WINS: inheriting a set ACPX_STATE_HOME would run every CLI test in this
      // file against the real session store while reading as isolated — and the
      // prune tests below DELETE session records. Isolated by construction, not by
      // the luck of the var being unset on the dev boxes. (brick://dd4cb0e8)
      ACPX_STATE_HOME: homeDir,
      ...options.env,
    };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
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

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function readJsonlIfExists<T>(file: string): Promise<T[]> {
  try {
    return await readJsonl<T>(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function mockCodexCommand(operationLog: string, extraArgs = ""): string {
  const args = [
    MOCK_AGENT_COMMAND,
    "--advertise-models",
    "--operation-log",
    JSON.stringify(operationLog),
    extraArgs,
  ].filter((arg) => arg.length > 0);
  return args.join(" ");
}

type MockOperation = {
  method?: string;
  sessionId?: string;
  modelId?: string;
  text?: string;
};

async function readMockOperations(operationLog: string): Promise<MockOperation[]> {
  const raw = await fs.readFile(operationLog, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockOperation);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
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
    template: record.template,
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

async function updateStoredSessionRecord(
  homeDir: string,
  acpxRecordId: string,
  mutate: (record: { metadata?: Record<string, unknown> }) => void,
): Promise<void> {
  const file = sessionFilePath(homeDir, acpxRecordId);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as {
    metadata?: Record<string, unknown>;
  };
  mutate(record);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

// FW-10: a fork flushes its inherited conversation to the messages-log sidecar
// (so it is stored like every normal session). Read it back to verify the
// inherited messages are retrievable the same way the UI hydrates them.
async function readForkMessagesLog(
  homeDir: string,
  acpxRecordId: string,
): Promise<SessionRecord["messages"]> {
  const logPath = path.join(
    homeDir,
    ".acpx",
    "sessions",
    `${encodeURIComponent(acpxRecordId)}.messages.ndjson`,
  );
  const raw = await fs.readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionRecord["messages"][number]);
}

// ── #3 Fork notice: settle it, never snapshot it ─────────────────────────────
// A plain (non-ephemeral) `sessions copy` deliberately queues a ⟦FORK-NOTICE⟧
// divergence handoff as the fork's turn 1 and RETURNS WITHOUT WAITING for it
// (handleSessionsCopy → deliverCopyHandoffPrompt, waitForCompletion: false —
// spawn-style fire-and-return). The child's transcript therefore keeps growing
// after the CLI process exits, so any message/sidecar snapshot taken "right
// after copy returns" races that intended write (brick://6b0c1df2 for the count,
// brick://5d72f693 for the two siblings). Wait for the SETTLED end state
// instead: the record and the sidecar are read together on every poll, so both
// sides have caught up before anything is asserted. The fire-and-return contract
// itself is unchanged and is proved separately by "sessions copy --prompt queues
// a non-blocking prompt handoff".
type SettledForkRecord = {
  last_seq?: unknown;
  messages?: unknown[];
  messages_log?: { count?: unknown; base_index?: unknown };
};

async function waitForSettledForkNotice(
  homeDir: string,
  childId: string,
  inheritedCount: number,
): Promise<{ record: SettledForkRecord; log: SessionRecord["messages"] }> {
  // the inherited prefix + the notice + the fork's reply to it.
  const settledCount = inheritedCount + 2;
  return await waitFor(async () => {
    const record = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, childId), "utf8"),
    ) as SettledForkRecord;
    const log = await readForkMessagesLog(homeDir, childId);
    return record.messages_log?.count === settledCount && log.length === settledCount
      ? { record, log }
      : null;
  }, 20_000);
}

// Turn 1 of the fork is the divergence notice itself — keyed on the stable
// FORK_NOTICE_MARKER (not on prose) and naming the source it diverged from —
// followed by the fork's reply, so the queued turn is proven to have RUN rather
// than merely been persisted. The fork index is asserted structurally by each
// caller (record lineage + where the notice sits in the settled log), so nothing
// here couples to the notice's wording beyond the marker and the source id.
function assertSettledForkNoticeTurn(
  log: SessionRecord["messages"],
  inheritedCount: number,
  sourceSessionId: string,
): void {
  const notice = log[inheritedCount];
  const noticeText =
    typeof notice === "object" && notice !== null && "User" in notice
      ? notice.User.content.map((block) => ("Text" in block ? block.Text : "")).join("")
      : "";
  assert.ok(
    noticeText.startsWith(FORK_NOTICE_MARKER),
    `expected the fork's turn 1 to be the divergence notice, got ${JSON.stringify(notice)}`,
  );
  assert.match(
    noticeText,
    new RegExp(`You were forked from session ${escapeRegex(sourceSessionId)}\\.`),
  );
  const reply = log[inheritedCount + 1];
  assert.ok(
    typeof reply === "object" && reply !== null && "Agent" in reply,
    `expected the notice turn to complete with an Agent reply, got ${JSON.stringify(reply)}`,
  );
}

// The queued notice turn leaves a live queue owner (and its mock agent) behind.
// Every caller runs this from a `finally` so that a failed assertion or a
// timed-out settle wait cannot strand one for the rest of the suite either.
async function closeForkedChildSession(
  homeDir: string,
  agentName: string,
  childId: string,
): Promise<void> {
  const close = await runCli([agentName, "sessions", "close", "--session-id", childId], homeDir);
  assert.equal(close.code, 0, close.stderr);
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
  template?: {
    enabled: boolean;
    created_at: string;
    source_session_id?: string;
    auto_prompt?: string;
  },
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

// B3 (RCA b2ca4bd0 §B.6) — the true silent drop.
//
// MEASURED before the fix, on a real closed session driven by the real CLI:
// `prompt --session-id <closed> --no-wait` returned rc=0 and printed
// `{"action":"prompt_queued",...}`, and the prompt then existed NOWHERE — no
// message, no delivery record, no `last_error`, no stream event, and no replay
// after the session was reopened.
//
// The property under test is LOUDNESS, not absence. Asserting "the prompt did
// not arrive" would pass against the broken behaviour too, since the broken
// behaviour also does not deliver. So these assert the rc and the detail code.
function parseCliJsonError(stdout: string): { message: string; detailCode: string } {
  const line = stdout
    .trim()
    .split("\n")
    .find((candidate) => candidate.includes('"error"'));
  assert(line, `no JSON error line in CLI output:\n${stdout}`);
  const parsed = JSON.parse(line) as {
    error?: { message?: unknown; data?: { detailCode?: unknown } };
  };
  const message = parsed.error?.message;
  const detailCode = parsed.error?.data?.detailCode;
  return {
    message: typeof message === "string" ? message : "",
    detailCode: typeof detailCode === "string" ? detailCode : "",
  };
}

test("B3: prompt --no-wait to a closed session fails loudly, while an open session still queues", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    const env = { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" };

    const makeSession = async (name: string): Promise<string> => {
      const created = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", name],
        homeDir,
        { env },
      );
      assert.equal(created.code, 0, created.stderr);
      return String((JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId);
    };

    const openId = await makeSession("b3-open");
    const closedId = await makeSession("b3-closed");

    // POSITIVE CONTROL, same execution: the identical `--no-wait` prompt against
    // an OPEN session. Without this, a fix that broke `--no-wait` outright — or a
    // check that refused everything — would still show a green suite below.
    const control = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "prompt",
        "--session-id",
        openId,
        "--no-wait",
        "control ping",
      ],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(control.code, 0, `open-session --no-wait must still queue:\n${control.stderr}`);
    assert.match(control.stdout, /"action":"prompt_queued"/);

    const closed = await runCli(
      ["--cwd", cwd, "codex", "sessions", "close", "--session-id", closedId],
      homeDir,
      { env },
    );
    assert.equal(closed.code, 0, closed.stderr);

    // THE DEFECT: this used to be rc=0 + `prompt_queued`.
    const refused = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "prompt",
        "--session-id",
        closedId,
        "--no-wait",
        "dropped ping",
      ],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(refused.code, 1, `closed-session --no-wait must fail loudly:\n${refused.stdout}`);
    assert.doesNotMatch(refused.stdout, /"action":"prompt_queued"/);
    const error = parseCliJsonError(refused.stdout);
    assert.equal(error.detailCode, "SESSION_CLOSED");
    // The guidance names the surfaces that exist. `acpx sessions reopen` does not,
    // and was removed in 2deef5c — it must not come back through this path.
    assert.match(error.message, /Reopen it in acpx-ui/);
    assert.doesNotMatch(error.message, /sessions reopen/);

    // Blocking mode was already honest; it must stay that way, and identically.
    const refusedBlocking = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "prompt",
        "--session-id",
        closedId,
        "blocking ping",
      ],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(refusedBlocking.code, 1, refusedBlocking.stdout);
    assert.equal(parseCliJsonError(refusedBlocking.stdout).detailCode, "SESSION_CLOSED");
  });
});

// The scope of the refusal IS the cross-repo contract. acpx-ui always spawns
// `prompt --no-wait --message-id <wireMessageId>`, and such a task already gets an
// honest owner-side SESSION_CLOSED_UNDELIVERED terminal that acpx-ui's senderNotify
// classifies as a definitive give-up. Refusing it here instead would swap a terminal
// acpx-ui understands for a non-zero exit it does not. This pins that acpx-ui keeps
// seeing exactly what it sees today.
test("B3: a closed-session prompt carrying --message-id keeps the acpx-ui delivery contract", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    const env = { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" };

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "b3-delivery"],
      homeDir,
      { env },
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const closed = await runCli(
      ["--cwd", cwd, "codex", "sessions", "close", "--session-id", id],
      homeDir,
      { env },
    );
    assert.equal(closed.code, 0, closed.stderr);

    const delivered = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "--message-id",
        "33333333-3333-4333-8333-333333333333",
        "an inter-agent delivery",
      ],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(
      delivered.code,
      0,
      `acpx-ui deliveries must NOT be refused at the CLI — they carry their own terminal:\n${delivered.stderr}`,
    );
    assert.match(delivered.stdout, /"action":"prompt_queued"/);
  });
});

// The closed-check sits at the single choke point for EVERY CLI submit. Two of its
// three callers are safe BY CONSTRUCTION — `sessions new --from-template` auto-fire
// and the `sessions copy` handoff both target a session created moments earlier,
// which cannot be closed. That argument is true today and silently expires the day
// either flow learns to target an EXISTING session, so it is pinned rather than
// left as reasoning in a comment.
test("B3 regression: the template auto-fire and copy handoff still submit through the closed-check", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, `${MOCK_AGENT_COMMAND} --supports-fork-session`);
    const env = { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" };

    const base = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "b3-tpl-base"],
      homeDir,
      { env },
    );
    assert.equal(base.code, 0, base.stderr);
    const baseId = String(
      (JSON.parse(base.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // A template source is a CLOSED record by design — the auto-fire targets the
    // fresh instance, not the template, so the closed-check must not trip on it.
    const closedBase = await runCli(
      ["--cwd", cwd, "codex", "sessions", "close", "--session-id", baseId],
      homeDir,
      { env },
    );
    assert.equal(closedBase.code, 0, closedBase.stderr);
    const marked = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "template", baseId, "--enable"],
      homeDir,
      { env },
    );
    assert.equal(marked.code, 0, marked.stderr);

    const instantiated = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--from-template",
        baseId,
        "--name",
        "b3-tpl-instance",
        "--prompt",
        "TPL AUTO FIRE",
      ],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(
      instantiated.code,
      0,
      `template auto-fire must still submit:\n${instantiated.stderr}`,
    );

    const copySource = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "b3-copy-source"],
      homeDir,
      { env },
    );
    assert.equal(copySource.code, 0, copySource.stderr);
    // `--from` by RECORD ID, not by name: the by-name lookup has its own scoping
    // rules that are not what this test is about.
    const copySourceId = String(
      (JSON.parse(copySource.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const copied = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        copySourceId,
        "--name",
        "b3-copy-dest",
        "--prompt",
        "COPY HANDOFF",
      ],
      homeDir,
      { env, timeoutMs: 60_000 },
    );
    assert.equal(copied.code, 0, `copy handoff must still submit:\n${copied.stderr}`);
  });
});

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
      messages_log?: { count?: unknown };
      name?: unknown;
    };
    assert.equal(stored.template, undefined, "instantiated session must NOT itself be a template");
    assert.notEqual(stored.closed, true, "instantiated session must be a normal OPEN session");
    assert.equal(
      stored.agent_command,
      MOCK_AGENT_WITH_FORK_SESSION,
      "inherits the template's agent type",
    );
    // FW-10 fix: an instantiated template inherits its context through the same
    // fork core, so the inherited messages live in the messages-log sidecar
    // (rendered like any normal session) and inline `messages` is the split-tail.
    assert.deepEqual(stored.messages, [], "context moved to the messages-log sidecar");
    assert.equal(stored.messages_log?.count, messages.length);
    assert.deepEqual(
      await readForkMessagesLog(homeDir, String(payload.acpxRecordId)),
      messages,
      "inherits the template's context",
    );
    assert.equal(stored.name, "instance");
  });
});

// ── GAP 1: parent-edge on the copy/template/fork path (both edges) ────────────
// A template/fork child must record BOTH its spawn-parent (parentSessionId/Url,
// from --parent-* flags or the ACPX_SESSION_URL env fallback) AND its template
// /fork origin (forkedFromSessionId). With no parent context the record is
// byte-identical to today (parent fields omitted).

test("sessions new --from-template records the env-fallback parent AND the template origin (both edges + task_folder inherit)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);

    // A real local parent so its task_folder is inheritable (matches plain-`new`).
    await writeSessionRecord(homeDir, {
      acpxRecordId: "parent-s",
      acpSessionId: "acp-parent-s",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "spawner",
      metadata: { task_folder: "/wisdom/task-x" },
    });
    await writeRecordWithTemplate(
      homeDir,
      {
        acpxRecordId: "tmpl-src",
        acpSessionId: "acp-tmpl-src",
        agentName: "codex",
        agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
        cwd,
        name: "blueprint",
        closed: true,
      },
      { enabled: true, created_at: "2026-06-01T05:00:00.000Z" },
    );

    const parentUrl = "https://test-ui.example/?session=parent-s";
    const result = await runCli(
      ["--format", "json", "codex", "sessions", "new", "--from-template", "tmpl-src"],
      homeDir,
      { env: { ACPX_SESSION_URL: parentUrl } },
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
    const childId = String(payload.acpxRecordId);

    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      parent_session_id?: unknown;
      forked_from_session_id?: unknown;
      template?: unknown;
      metadata?: Record<string, unknown>;
    };
    // Both persisted edges present: the spawn-parent (parent_session_id) AND the
    // template origin (forked_from_session_id). (parentSessionUrl is a runtime
    // sessionContext hint for cross-box adapter lineage, not a persisted record
    // field — serialize.ts persists only parent_session_id, which is what the
    // acpx-ui relations graph keys on.)
    assert.equal(stored.parent_session_id, "parent-s");
    assert.equal(stored.forked_from_session_id, "tmpl-src");
    // The instantiated session is itself a normal session, not a template.
    assert.equal(stored.template, undefined);
    // task_folder inherited from the spawner (matches plain-`new`).
    assert.equal(stored.metadata?.task_folder, "/wisdom/task-x");
    // Template-spawn discriminator: lets the board place this under its creator
    // with a "from template" badge, distinct from a plain fork (which has the
    // same parent_session_id + forked_from_session_id but NO template_source).
    assert.equal(stored.metadata?.template_source, "tmpl-src");
  });
});

test("sessions copy records an explicit --parent-session-url / --parent-id parent (both edges)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-x",
      acpSessionId: "acp-source-x",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
    });

    // (1) --parent-session-url
    const byUrl = await runCli(
      [
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-x",
        "--parent-session-url",
        "https://test-ui.example/?session=spawner-u",
      ],
      homeDir,
    );
    assert.equal(byUrl.code, 0, byUrl.stderr);
    const urlChild = String(
      (JSON.parse(byUrl.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const urlStored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, urlChild), "utf8")) as {
      parent_session_id?: unknown;
      forked_from_session_id?: unknown;
    };
    // --parent-session-url resolves the UUID from ?session= and records it as the
    // parent edge (the URL itself is a runtime-only cross-box lineage hint, not a
    // persisted record field).
    assert.equal(urlStored.parent_session_id, "spawner-u");
    assert.equal(urlStored.forked_from_session_id, "source-x");

    // (2) --parent-id (same-box; no url recorded, derived downstream)
    const byId = await runCli(
      [
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-x",
        "--parent-id",
        "source-x",
      ],
      homeDir,
    );
    assert.equal(byId.code, 0, byId.stderr);
    const idChild = String(
      (JSON.parse(byId.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const idStored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, idChild), "utf8")) as {
      parent_session_id?: unknown;
      forked_from_session_id?: unknown;
    };
    assert.equal(idStored.parent_session_id, "source-x");
    assert.equal(idStored.forked_from_session_id, "source-x");
  });
});

test("sessions copy with NO parent context omits parent fields (fork regression — byte-identical)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-noparent",
      acpSessionId: "acp-source-noparent",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
    });

    // No --parent-* flag and ACPX_SESSION_URL is stripped by runCli → no parent.
    const result = await runCli(
      ["--format", "json", "codex", "sessions", "copy", "--from", "source-noparent"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const childId = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, childId), "utf8"),
    ) as Record<string, unknown>;
    // Parent fields must be entirely absent (omitted, not null) — same shape as today.
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, "parent_session_id"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, "parent_session_url"), false);
    assert.equal(onDisk["forked_from_session_id"], "source-noparent");
    // A plain copy/fork must NOT carry the template-spawn discriminator.
    const meta = (onDisk["metadata"] ?? {}) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(meta, "template_source"), false);
  });
});

test("sessions copy --prompt queues a non-blocking prompt handoff into the copied session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-prompt-handoff",
      acpSessionId: "acp-source-prompt-handoff",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
    });

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "--ttl",
        "0.2",
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-prompt-handoff",
        "--name",
        "handoff-child",
        "--prompt",
        "sleep 5000",
      ],
      homeDir,
      // Keep this below the injected prompt sleep so the assertion still proves
      // copy returns without waiting for the handoff prompt to finish, while
      // leaving enough headroom for full-suite process startup contention.
      // Mock sleep is 5 s; 4 s gives ample startup margin on a loaded box while
      // staying under the ceiling so the non-blocking guarantee is measurable.
      { timeoutMs: 4_000 },
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      action?: unknown;
      acpxRecordId?: unknown;
      sessionUrl?: unknown;
    };
    assert.equal(payload.action, "session_copied");
    assert.equal(typeof payload.acpxRecordId, "string");
    assert.match(String(payload.sessionUrl), new RegExp(`session=${String(payload.acpxRecordId)}`));

    const childId = String(payload.acpxRecordId);
    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      forked_from_session_id?: unknown;
      name?: unknown;
    };
    assert.equal(stored.forked_from_session_id, "source-prompt-handoff");
    assert.equal(stored.name, "handoff-child");

    await waitFor(async () => {
      const history = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "read", "--session-id", childId],
        homeDir,
      );
      if (history.code !== 0) {
        return null;
      }
      const read = JSON.parse(history.stdout.trim()) as {
        entries?: Array<{ textPreview?: unknown }>;
      };
      const previews = read.entries?.map((entry) => entry.textPreview);
      return previews?.includes("slept 5000ms") ? previews : null;
    }, 20_000);

    const close = await runCli(["codex", "sessions", "close", "--session-id", childId], homeDir);
    assert.equal(close.code, 0, close.stderr);
  });
});

test("sessions fork --prompt-file queues prompt handoff from a file", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-file-handoff",
      acpSessionId: "acp-source-file-handoff",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
    });
    await fs.writeFile(path.join(cwd, "handoff.txt"), "echo file-handoff\n", "utf8");

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "--ttl",
        "0.2",
        "codex",
        "sessions",
        "fork",
        "--from",
        "source-file-handoff",
        "--prompt-file",
        "handoff.txt",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
    const childId = String(payload.acpxRecordId);

    await waitFor(async () => {
      const history = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "read", "--session-id", childId],
        homeDir,
      );
      if (history.code !== 0) {
        return null;
      }
      const read = JSON.parse(history.stdout.trim()) as {
        entries?: Array<{ textPreview?: unknown }>;
      };
      const previews = read.entries?.map((entry) => entry.textPreview);
      return previews?.includes("file-handoff") ? previews : null;
    }, 20_000);

    const close = await runCli(["codex", "sessions", "close", "--session-id", childId], homeDir);
    assert.equal(close.code, 0, close.stderr);
  });
});

test("sessions copy rejects combining --prompt and --prompt-file before creating a copy", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-conflict-handoff",
      acpSessionId: "acp-source-conflict-handoff",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
    });
    await fs.writeFile(path.join(cwd, "handoff.txt"), "echo file-handoff\n", "utf8");

    const before = await listSessionRecordFiles(homeDir);
    const result = await runCli(
      [
        "--cwd",
        cwd,
        "codex",
        "sessions",
        "copy",
        "--from",
        "source-conflict-handoff",
        "--prompt",
        "echo inline",
        "--prompt-file",
        "handoff.txt",
      ],
      homeDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stderr}${result.stdout}`, /Use only one of --prompt or --prompt-file/);
    assert.deepEqual(await listSessionRecordFiles(homeDir), before);
  });
});

test("sessions new --from-template auto-prompt still fires once and does not use copy handoff flags", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeRecordWithTemplate(
      homeDir,
      {
        acpxRecordId: "tmpl-auto-prompt",
        acpSessionId: "acp-tmpl-auto-prompt",
        agentName: "codex",
        agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
        cwd,
        name: "blueprint",
        closed: true,
      },
      {
        enabled: true,
        created_at: "2026-06-01T05:00:00.000Z",
        auto_prompt: "echo template-auto-handoff",
      },
    );

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "--ttl",
        "0.2",
        "codex",
        "sessions",
        "new",
        "--from-template",
        "tmpl-auto-prompt",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
    const childId = String(payload.acpxRecordId);

    const previews = await waitFor(async () => {
      const history = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "read", "--session-id", childId],
        homeDir,
      );
      if (history.code !== 0) {
        return null;
      }
      const read = JSON.parse(history.stdout.trim()) as {
        entries?: Array<{ textPreview?: unknown }>;
      };
      const textPreviews = read.entries?.map((entry) => entry.textPreview);
      return textPreviews?.includes("template-auto-handoff") ? textPreviews : null;
    }, 5_000);

    assert.equal(previews.filter((preview) => preview === "echo template-auto-handoff").length, 1);
    assert.equal(previews.filter((preview) => preview === "template-auto-handoff").length, 1);

    const close = await runCli(["codex", "sessions", "close", "--session-id", childId], homeDir);
    assert.equal(close.code, 0, close.stderr);
  });
});

test("sessions copy --ephemeral inside a session stamps byway AND carries the parent edge (byway markers intact)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "source-byway",
      acpSessionId: "acp-source-byway",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "source",
    });

    const result = await runCli(
      ["--format", "json", "codex", "sessions", "copy", "--from", "source-byway", "--ephemeral"],
      homeDir,
      { env: { ACPX_SESSION_URL: "https://test-ui.example/?session=spawner-b" } },
    );
    assert.equal(result.code, 0, result.stderr);
    const childId = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, childId), "utf8")) as {
      parent_session_id?: unknown;
      metadata?: Record<string, unknown>;
    };
    // byway markers must still be present so acpx-ui's `kind!=='byway'` graph
    // guard keeps the copy out of the relations graph even though it now carries
    // a parent edge.
    assert.equal(stored.metadata?.byway, "1");
    assert.equal(stored.metadata?.byway_parent, "source-byway");
    assert.equal(stored.parent_session_id, "spawner-b");
  });
});

// ── #3: template params as defaults, explicit --model/--reasoning-effort wins ─

test("sessions new --from-template uses template params by default and lets explicit flags override", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const claudeCommand = `${MOCK_AGENT_COMMAND} --claude-agent-acp --advertise-models --advertise-config-options --supports-fork-session`;
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command: claudeCommand } } }, null, 2)}\n`,
      "utf8",
    );

    // Template baked with model=opus[1m], effort=high.
    await writeRecordWithTemplate(
      homeDir,
      {
        acpxRecordId: "tmpl-params",
        acpSessionId: "acp-tmpl-params",
        agentName: "claude",
        agentCommand: claudeCommand,
        cwd,
        name: "blueprint",
        closed: true,
        acpx: {
          session_options: { model: "opus[1m]" },
          desired_config_options: { effort: "high" },
        },
      },
      { enabled: true, created_at: "2026-06-01T05:00:00.000Z" },
    );

    // (a) No flags → template defaults.
    const defaults = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "claude",
        "sessions",
        "new",
        "--from-template",
        "tmpl-params",
      ],
      homeDir,
    );
    assert.equal(defaults.code, 0, defaults.stderr);
    const defChild = String(
      (JSON.parse(defaults.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const defStored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, defChild), "utf8")) as {
      acpx?: {
        session_options?: { model?: unknown };
        desired_config_options?: { effort?: unknown };
      };
    };
    assert.equal(defStored.acpx?.session_options?.model, "opus[1m]");
    assert.equal(defStored.acpx?.desired_config_options?.effort, "high");

    // (b) Explicit --model/--reasoning-effort override the template values.
    const overridden = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "--model",
        "sonnet",
        "--reasoning-effort",
        "low",
        "claude",
        "sessions",
        "new",
        "--from-template",
        "tmpl-params",
      ],
      homeDir,
    );
    assert.equal(overridden.code, 0, overridden.stderr);
    const ovChild = String(
      (JSON.parse(overridden.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const ovStored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, ovChild), "utf8")) as {
      acpx?: {
        session_options?: { model?: unknown };
        desired_config_options?: { effort?: unknown };
        config_options?: Array<{ id?: unknown; currentValue?: unknown }>;
      };
    };
    assert.equal(ovStored.acpx?.session_options?.model, "sonnet");
    assert.equal(ovStored.acpx?.desired_config_options?.effort, "low");
    // The override reaches the downstream apply path (advertised config option).
    const effortOption = ovStored.acpx?.config_options?.find((o) => o.id === "effort");
    assert.equal(effortOption?.currentValue, "low");
  });
});

// ── #4: create ops return the child's acpx-ui URL (stderr banner + JSON) ──────

test("create ops emit the acpx-ui URL on stderr banner + JSON without changing stdout's id token", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_WITH_FORK_SESSION);
    const uiEnv = { ACPX_UI_BASE_URL: "https://test-ui.example" };

    // sessions new — default format: id-only on stdout, url on stderr banner.
    const created = await runCli(["--cwd", cwd, "codex", "sessions", "new", "-s", "n1"], homeDir, {
      env: uiEnv,
    });
    assert.equal(created.code, 0, created.stderr);
    const newId = created.stdout.trim();
    assert.match(newId, /^[0-9a-f-]{36}$/, "stdout first token is the bare id");
    assert.match(
      created.stderr,
      new RegExp(`\\[acpx\\] url: https://test-ui\\.example/\\?session=${newId}`),
    );

    // sessions new --format json: additive sessionUrl field.
    const createdJson = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "-s", "n2"],
      homeDir,
      { env: uiEnv },
    );
    assert.equal(createdJson.code, 0, createdJson.stderr);
    const newPayload = JSON.parse(createdJson.stdout.trim()) as {
      acpxRecordId?: unknown;
      sessionUrl?: unknown;
    };
    assert.equal(
      newPayload.sessionUrl,
      `https://test-ui.example/?session=${String(newPayload.acpxRecordId)}`,
    );

    // sessions copy --format json: additive sessionUrl field.
    await writeSessionRecord(homeDir, {
      acpxRecordId: "src-url",
      acpSessionId: "acp-src-url",
      agentName: "codex",
      agentCommand: MOCK_AGENT_WITH_FORK_SESSION,
      cwd,
      name: "src",
    });
    const copied = await runCli(
      ["--format", "json", "codex", "sessions", "copy", "--from", "src-url"],
      homeDir,
      { env: uiEnv },
    );
    assert.equal(copied.code, 0, copied.stderr);
    const copyPayload = JSON.parse(copied.stdout.trim()) as {
      acpxRecordId?: unknown;
      sessionUrl?: unknown;
    };
    assert.equal(
      copyPayload.sessionUrl,
      `https://test-ui.example/?session=${String(copyPayload.acpxRecordId)}`,
    );
  });
});

// ── CLI template verb: `sessions template <id> --enable|--disable` ───────────

// enable marks + closes, the marker SURVIVES a re-read (guards the
// privileged-writer requirement — a plain write would read-preserve it away),
// lists under `templates`, and `--disable` clears it while leaving it closed.
test("sessions template --enable marks + closes and survives a re-read; --disable clears", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);

    await writeSessionRecord(homeDir, {
      acpxRecordId: "to-template",
      acpSessionId: "acp-to-template",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
      name: "candidate",
    });

    const enabled = await runCli(
      ["--format", "json", "codex", "sessions", "template", "to-template", "--enable"],
      homeDir,
    );
    assert.equal(enabled.code, 0, enabled.stderr);
    const enPayload = JSON.parse(enabled.stdout.trim()) as {
      action?: unknown;
      template?: unknown;
      closed?: unknown;
    };
    assert.equal(enPayload.action, "template_enabled");
    assert.equal(enPayload.template, true);
    assert.equal(enPayload.closed, true);

    // Re-read from disk: the marker must have PERSISTED (privileged write worked).
    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "to-template"), "utf8"),
    ) as {
      template?: { enabled?: unknown; created_at?: unknown; source_session_id?: unknown };
      closed?: unknown;
    };
    assert.equal(stored.template?.enabled, true, "marker survived the re-read");
    assert.equal(typeof stored.template?.created_at, "string");
    assert.equal(stored.template?.source_session_id, "acp-to-template");
    assert.equal(stored.closed, true);

    const listed = await runCli(["--format", "json", "codex", "sessions", "templates"], homeDir);
    const list = JSON.parse(listed.stdout.trim()) as Array<{ acpxRecordId: string }>;
    assert.ok(
      list.some((s) => s.acpxRecordId === "to-template"),
      "now listed as a template",
    );

    const disabled = await runCli(
      ["--format", "json", "codex", "sessions", "template", "to-template", "--disable"],
      homeDir,
    );
    assert.equal(disabled.code, 0, disabled.stderr);
    const storedAfter = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "to-template"), "utf8"),
    ) as { template?: unknown; closed?: unknown };
    assert.equal(storedAfter.template, undefined, "marker cleared");
    assert.equal(storedAfter.closed, true, "disable does not reopen");

    const listedAfter = await runCli(
      ["--format", "json", "codex", "sessions", "templates"],
      homeDir,
    );
    const listAfter = JSON.parse(listedAfter.stdout.trim()) as Array<{ acpxRecordId: string }>;
    assert.ok(!listAfter.some((s) => s.acpxRecordId === "to-template"), "no longer listed");
  });
});

// Default action when neither flag is passed = enable.
test("sessions template with no flag defaults to enable", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "default-on",
      acpSessionId: "acp-default-on",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
    });

    const result = await runCli(
      ["--format", "json", "codex", "sessions", "template", "default-on"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const stored = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "default-on"), "utf8"),
    ) as {
      template?: { enabled?: unknown };
      closed?: unknown;
    };
    assert.equal(stored.template?.enabled, true);
    assert.equal(stored.closed, true);
  });
});

// --enable + --disable together is a clean error.
test("sessions template --enable --disable is rejected", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "conflict",
      acpSessionId: "acp-conflict",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
    });

    const result = await runCli(
      ["codex", "sessions", "template", "conflict", "--enable", "--disable"],
      homeDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(`${result.stderr}${result.stdout}`, /mutually exclusive/i);
  });
});

// --enable on an already-template is idempotent and preserves the original created_at.
test("sessions template --enable twice is idempotent and preserves created_at", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "twice",
      acpSessionId: "acp-twice",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
    });

    const first = await runCli(["codex", "sessions", "template", "twice", "--enable"], homeDir);
    assert.equal(first.code, 0, first.stderr);
    const afterFirst = JSON.parse(await fs.readFile(sessionFilePath(homeDir, "twice"), "utf8")) as {
      template?: { created_at?: unknown };
    };
    const createdAt = afterFirst.template?.created_at;
    assert.equal(typeof createdAt, "string");

    const second = await runCli(["codex", "sessions", "template", "twice", "--enable"], homeDir);
    assert.equal(second.code, 0, second.stderr);
    const afterSecond = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "twice"), "utf8"),
    ) as {
      template?: { enabled?: unknown; created_at?: unknown };
    };
    assert.equal(afterSecond.template?.enabled, true);
    assert.equal(afterSecond.template?.created_at, createdAt, "original created_at preserved");
  });
});

// --disable on a non-template is a no-op success.
test("sessions template --disable on a non-template succeeds as a no-op", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    await writeSessionRecord(homeDir, {
      acpxRecordId: "plain",
      acpSessionId: "acp-plain",
      agentName: "codex",
      agentCommand: MOCK_AGENT_COMMAND,
      cwd,
    });

    const result = await runCli(["codex", "sessions", "template", "plain", "--disable"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, "plain"), "utf8")) as {
      template?: unknown;
    };
    assert.equal(stored.template, undefined);
  });
});

// Unknown id surfaces a clean error.
test("sessions template on an unknown id errors cleanly", async () => {
  await withTempHome(async (homeDir) => {
    await writeCodexAgentConfig(homeDir, MOCK_AGENT_COMMAND);
    const result = await runCli(
      ["codex", "sessions", "template", "does-not-exist", "--enable"],
      homeDir,
    );
    assert.notEqual(result.code, 0);
  });
});
