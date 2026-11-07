// brick://4271b338 — this file reaches the real CLI, which spawns `__queue-owner` daemons.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queuePaths } from "./queue-test-helpers.js";
import { withTempHome } from "./temp-home.js";

// brick 45917618 (CONCEPTION c53cbd97 §5.2–§5.6, §5.8) — the fixed session root through the REAL
// CLI, with the seams the rig uses: `ACPX_SESSION_ROOT=<root>` (enforcement on, as on a devN rig),
// `ACPX_SESSION_ROOT=` (off, for legacy fixtures) and `NV_DEV_SERVER_ROLE=control` (the
// control-pod branch). The root here is a temp dir standing in for `/workspace`. TEST-PLAN rows are
// named in each test title.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const INERT_LINE = "does not apply to new sessions: every new session starts in";

type CliResult = { code: number | null; stdout: string; stderr: string };

type Fixture = {
  homeDir: string;
  /** The session root (enforcement on). */
  root: string;
  /** A folder the spawning shell stands in — a stand-in for a git worktree. */
  worktree: string;
  /** A second, unrelated folder. */
  elsewhere: string;
  opsLog: string;
};

function agentArgs(fx: Fixture): string[] {
  const command = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session --operation-log ${JSON.stringify(fx.opsLog)}`;
  return ["--agent", command, "--approve-all"];
}

async function runCli(
  fx: Fixture,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; homeDir?: string } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.homeDir ?? fx.homeDir };
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SESSION_NAME",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_BRICK",
    "ACPX_BRICK_PATH",
    "ACPX_SUBSCRIPTION",
    "ACPX_SESSION_ROOT",
    "NV_DEV_SERVER_ROLE",
  ]) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(options.env ?? { ACPX_SESSION_ROOT: fx.root })) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: options.cwd ?? fx.worktree,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: acpx ${args.join(" ")}`));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function withFixture(run: (fx: Fixture) => Promise<void>): Promise<void> {
  await withTempHome("acpx-session-root-home-", async (homeDir) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-session-root-"));
    try {
      const fx: Fixture = {
        homeDir,
        root: path.join(base, "workspace-root"),
        worktree: path.join(base, "projects", "demo", "feat-wt"),
        elsewhere: path.join(base, "elsewhere"),
        opsLog: path.join(base, "ops.jsonl"),
      };
      for (const dir of [fx.root, fx.worktree, fx.elsewhere]) {
        await fs.mkdir(dir, { recursive: true });
      }
      await run(fx);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
}

async function readRecord(fx: Fixture, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(fx.homeDir, ".acpx", "sessions", `${id}.json`), "utf8"),
  ) as Record<string, unknown>;
}

async function readOps(fx: Fixture): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(fx.opsLog, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function inertLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.includes(INERT_LINE));
}

function parseResult(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

async function createSession(
  fx: Fixture,
  extra: string[] = [],
  options: Parameters<typeof runCli>[2] = {},
  newFlags: string[] = [],
): Promise<Record<string, unknown>> {
  const created = await runCli(
    fx,
    [...agentArgs(fx), ...extra, "--format", "json", "sessions", "new", ...newFlags],
    options,
  );
  assert.equal(created.code, 0, created.stderr);
  return parseResult(created.stdout);
}

test("A1/A11: a create from a shell standing in a worktree, no --cwd, lands at the root — silently", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(fx, [...agentArgs(fx), "--format", "json", "sessions", "new"]);
    assert.equal(created.code, 0, created.stderr);
    const result = parseResult(created.stdout);
    assert.equal(result.cwd, fx.root);
    assert.equal(Object.hasOwn(result, "requestedCwd"), false);
    assert.deepEqual(inertLines(created.stderr), [], "no --cwd was given, so nothing is announced");
    const record = await readRecord(fx, String(result.acpxRecordId));
    assert.equal(record.cwd, fx.root);
    // The adapter itself was asked for, and stands in, the root — not the spawner's worktree.
    const newOps = (await readOps(fx)).filter((op) => op.method === "session/new");
    assert.ok(newOps.length >= 1);
    for (const op of newOps) {
      assert.equal(op.cwd, fx.root);
      assert.equal(op.processCwd, fx.root);
    }
  });
});

test("B1: an explicit --cwd <worktree> is inert: exit 0, root cwd, requestedCwd, exactly one line", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(
      fx,
      [...agentArgs(fx), "--cwd", fx.worktree, "--format", "json", "sessions", "new"],
      { cwd: fx.elsewhere },
    );
    assert.equal(created.code, 0, created.stderr);
    const result = parseResult(created.stdout);
    assert.equal(result.cwd, fx.root);
    assert.equal(result.requestedCwd, fx.worktree);
    assert.deepEqual(inertLines(created.stderr), [
      `[acpx] --cwd ${fx.worktree} does not apply to new sessions: every new session starts in ` +
        `${fx.root} (fixed session root, Daniel 2026-11-06). Name the folder in the prompt; the ` +
        `agent can cd into it.`,
    ]);
    assert.equal((await readRecord(fx, String(result.acpxRecordId))).cwd, fx.root);
  });
});

test("B2: --cwd equal to the root (trailing slash) is silent and carries no requestedCwd", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(fx, [
      ...agentArgs(fx),
      "--cwd",
      `${fx.root}/`,
      "--format",
      "json",
      "sessions",
      "new",
    ]);
    assert.equal(created.code, 0, created.stderr);
    const result = parseResult(created.stdout);
    assert.equal(result.cwd, fx.root);
    assert.equal(Object.hasOwn(result, "requestedCwd"), false);
    assert.deepEqual(inertLines(created.stderr), []);
  });
});

test("B3: under --json-strict stderr stays empty and requestedCwd is the machine signal", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(fx, [
      ...agentArgs(fx),
      "--cwd",
      fx.worktree,
      "--format",
      "json",
      "--json-strict",
      "sessions",
      "new",
    ]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stderr.trim(), "");
    const result = parseResult(created.stdout);
    assert.equal(result.cwd, fx.root);
    assert.equal(result.requestedCwd, fx.worktree);
  });
});

test("B6: enforcement off (no env, not a control pod) keeps upstream behaviour — no re-root, no line", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(
      fx,
      [...agentArgs(fx), "--cwd", fx.worktree, "--format", "json", "sessions", "new"],
      { env: {} },
    );
    assert.equal(created.code, 0, created.stderr);
    const result = parseResult(created.stdout);
    assert.equal(result.cwd, fx.worktree);
    assert.equal(Object.hasOwn(result, "requestedCwd"), false);
    assert.deepEqual(inertLines(created.stderr), []);
    assert.equal(created.stderr.includes("overrides the fixed session root"), false);
  });
});

test("B7: a control pod with ACPX_SESSION_ROOT empty is off, and says so once", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(
      fx,
      [...agentArgs(fx), "--cwd", fx.worktree, "--format", "json", "sessions", "new"],
      { env: { NV_DEV_SERVER_ROLE: "control", ACPX_SESSION_ROOT: "" } },
    );
    assert.equal(created.code, 0, created.stderr);
    assert.equal(parseResult(created.stdout).cwd, fx.worktree);
    const notices = created.stderr
      .split("\n")
      .filter((line) => line.includes("overrides the fixed session root"));
    assert.deepEqual(notices, [
      "[acpx] ACPX_SESSION_ROOT=(empty) overrides the fixed session root on this control pod (test and rig use only)",
    ]);
  });
});

test("B8: a relative ACPX_SESSION_ROOT refuses the create with a usage error; nothing is created", async () => {
  await withFixture(async (fx) => {
    const created = await runCli(fx, [...agentArgs(fx), "--format", "json", "sessions", "new"], {
      env: { ACPX_SESSION_ROOT: "relative/dir" },
    });
    assert.notEqual(created.code, 0);
    assert.match(created.stdout + created.stderr, /ACPX_SESSION_ROOT/);
    const sessions = await fs.readdir(path.join(fx.homeDir, ".acpx", "sessions")).catch(() => []);
    assert.deepEqual(
      sessions.filter((name) => name.endsWith(".json") && name !== "index.json"),
      [],
    );
  });
});

test("B5/D4/D10: copies and --from successors of a root or legacy source land at the root", async () => {
  await withFixture(async (fx) => {
    // A LEGACY source: created with enforcement off in its own folder (the TEST-PLAN fixture shape).
    const legacy = await createSession(fx, ["--cwd", fx.elsewhere], {
      env: { ACPX_SESSION_ROOT: "" },
    });
    const legacyId = String(legacy.acpxRecordId);
    assert.equal(legacy.cwd, fx.elsewhere, "planted positive: the fixture really is legacy");
    // One real turn, so the copy FORKS (a source with no messages is copied by a plain create).
    const turn = await runCli(
      fx,
      [...agentArgs(fx), "prompt", "--session-id", legacyId, "echo planted"],
      { env: { ACPX_SESSION_ROOT: "" } },
    );
    assert.equal(turn.code, 0, turn.stdout + turn.stderr);

    const copied = await runCli(fx, [
      ...agentArgs(fx),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      legacyId,
    ]);
    assert.equal(copied.code, 0, copied.stderr);
    const copy = parseResult(copied.stdout);
    assert.equal(copy.action, "session_copied");
    assert.equal(copy.cwd, fx.root);
    assert.equal((await readRecord(fx, String(copy.acpxRecordId))).cwd, fx.root);
    // The fork request itself ran at the destination, never at the source folder.
    const forks = (await readOps(fx)).filter((op) => op.method === "session/fork");
    assert.ok(forks.length >= 1, "the copy forked");
    assert.equal(forks.at(-1)?.cwd, fx.root);
    // The legacy source keeps its folder (acpx never rewrites record.cwd).
    assert.equal((await readRecord(fx, legacyId)).cwd, fx.elsewhere);

    // B5: an explicit --cwd on a copy is inert, announced once, reported as requestedCwd.
    const copiedWithCwd = await runCli(fx, [
      ...agentArgs(fx),
      "--cwd",
      fx.worktree,
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      legacyId,
    ]);
    assert.equal(copiedWithCwd.code, 0, copiedWithCwd.stderr);
    const copy2 = parseResult(copiedWithCwd.stdout);
    assert.equal(copy2.cwd, fx.root);
    assert.equal(copy2.requestedCwd, fx.worktree);
    assert.equal(inertLines(copiedWithCwd.stderr).length, 1);

    // D10: a `--from` successor of the legacy source starts at the root too.
    const successor = await runCli(fx, [
      ...agentArgs(fx),
      "--format",
      "json",
      "sessions",
      "new",
      "--from",
      legacyId,
    ]);
    assert.equal(successor.code, 0, successor.stderr);
    assert.equal(parseResult(successor.stdout).cwd, fx.root);
  });
});

test("B6 control: with enforcement off a copy still inherits the source's cwd (upstream behaviour)", async () => {
  await withFixture(async (fx) => {
    const off = { env: { ACPX_SESSION_ROOT: "" } };
    const source = await createSession(fx, ["--cwd", fx.elsewhere], off);
    const copied = await runCli(
      fx,
      [
        ...agentArgs(fx),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        String(source.acpxRecordId),
      ],
      off,
    );
    assert.equal(copied.code, 0, copied.stderr);
    assert.equal(parseResult(copied.stdout).cwd, fx.elsewhere);
  });
});

test("E1/E5: a session whose folder was deleted is refused SESSION_CWD_MISSING; the folder stays gone; a copy works", async () => {
  await withFixture(async (fx) => {
    const gone = path.join(fx.elsewhere, "gone-legacy");
    await fs.mkdir(gone);
    const legacy = await createSession(fx, ["--cwd", gone], { env: { ACPX_SESSION_ROOT: "" } });
    const id = String(legacy.acpxRecordId);
    assert.equal(existsSync(gone), true, "planted positive: the folder existed");
    await fs.rm(gone, { recursive: true, force: true });

    const prompted = await runCli(fx, [
      ...agentArgs(fx),
      "--format",
      "json",
      "prompt",
      "--session-id",
      id,
      "hello",
    ]);
    assert.notEqual(prompted.code, 0);
    const output = prompted.stdout + prompted.stderr;
    assert.match(output, /SESSION_CWD_MISSING/);
    assert.ok(
      output.includes(`cannot start: its working directory ${gone} no longer exists`),
      output,
    );
    assert.ok(output.includes(`acpx sessions copy --from ${id}`), "the copy remedy is named");
    assert.equal(existsSync(gone), false, "the folder must NOT be re-created");

    // E5: the remedy works — the copy starts at the root, without the old folder.
    const copied = await runCli(fx, [
      ...agentArgs(fx),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      id,
    ]);
    assert.equal(copied.code, 0, copied.stderr);
    assert.equal(parseResult(copied.stdout).cwd, fx.root);
    assert.equal(existsSync(gone), false);
  });
});

test("A6: exec is a new session — it runs at the root, and an explicit --cwd is announced once", async () => {
  await withFixture(async (fx) => {
    const executed = await runCli(fx, [
      ...agentArgs(fx),
      "--cwd",
      fx.worktree,
      "--format",
      "quiet",
      "exec",
      "echo hi",
    ]);
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(inertLines(executed.stderr).length, 1);
    const newOps = (await readOps(fx)).filter((op) => op.method === "session/new");
    assert.equal(newOps.at(-1)?.cwd, fx.root);
    assert.equal(newOps.at(-1)?.processCwd, fx.root);
  });
});

test("A7: an imported session starts at the root; `sessions import --cwd` is inert and named", async () => {
  await withFixture(async (fx) => {
    const source = await createSession(fx, ["--cwd", fx.elsewhere], {
      env: { ACPX_SESSION_ROOT: "" },
    });
    const archive = path.join(fx.elsewhere, "export.json");
    const exported = await runCli(
      fx,
      [
        ...agentArgs(fx),
        "sessions",
        "export",
        "--session-id",
        String(source.acpxRecordId),
        "--output",
        archive,
      ],
      { env: { ACPX_SESSION_ROOT: "" } },
    );
    assert.equal(exported.code, 0, exported.stderr);
    // Imported into a SECOND home: one store refuses an archive whose provider session it holds.
    const importHome = path.join(fx.elsewhere, "import-home");
    await fs.mkdir(importHome);
    const imported = await runCli(
      fx,
      [...agentArgs(fx), "--format", "json", "sessions", "import", archive, "--cwd", fx.worktree],
      { homeDir: importHome },
    );
    assert.equal(imported.code, 0, imported.stdout + imported.stderr);
    const result = parseResult(imported.stdout);
    assert.equal(result.cwd, fx.root);
    assert.equal(result.requestedCwd, fx.worktree);
    const lines = inertLines(imported.stderr);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.startsWith(`[acpx] sessions import --cwd ${fx.worktree} `), lines[0]);
    const record = JSON.parse(
      await fs.readFile(
        path.join(importHome, ".acpx", "sessions", `${String(result.record_id)}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(record.cwd, fx.root);
  });
});

test("G23(b)/G24: worktree survives a real turn; a copy and a --from successor carry it", async () => {
  await withFixture(async (fx) => {
    const source = await createSession(fx, [], {}, [
      "--metadata",
      `worktree_path=${fx.worktree}`,
      "--metadata",
      "worktree_branch=feat-wt",
      "--metadata",
      `worktree_repo=${path.dirname(fx.worktree)}`,
    ]);
    const sourceId = String(source.acpxRecordId);
    // G23(b): one REAL turn first — the turn path rebuilds the record, and the projection must
    // survive it (the metadata keys are flat, outside the `record.acpx` allowlist).
    const turn = await runCli(fx, [...agentArgs(fx), "prompt", "--session-id", sourceId, "echo t"]);
    assert.equal(turn.code, 0, turn.stdout + turn.stderr);
    const copied = await runCli(fx, [
      ...agentArgs(fx),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      sourceId,
    ]);
    assert.equal(copied.code, 0, copied.stderr);
    const successor = await runCli(fx, [
      ...agentArgs(fx),
      "--format",
      "json",
      "sessions",
      "new",
      "--from",
      sourceId,
    ]);
    assert.equal(successor.code, 0, successor.stderr);
    const index = JSON.parse(
      await fs.readFile(path.join(fx.homeDir, ".acpx", "sessions", "index.json"), "utf8"),
    ) as { entries: Array<{ acpxRecordId: string; worktree?: unknown }> };
    const expected = { path: fx.worktree, branch: "feat-wt", repo: path.dirname(fx.worktree) };
    for (const id of [
      sourceId,
      String(parseResult(copied.stdout).acpxRecordId),
      String(parseResult(successor.stdout).acpxRecordId),
    ]) {
      assert.deepEqual(
        index.entries.find((entry) => entry.acpxRecordId === id)?.worktree,
        expected,
        id,
      );
    }
  });
});

test("C4: the prompt banner drops '(routed from …)' for a root session and keeps it for a legacy one", async () => {
  await withFixture(async (fx) => {
    const rooted = await createSession(fx);
    const legacy = await createSession(fx, ["--cwd", fx.elsewhere], {
      env: { ACPX_SESSION_ROOT: "" },
    });
    const rootPrompt = await runCli(fx, [
      ...agentArgs(fx),
      "prompt",
      "--session-id",
      String(rooted.acpxRecordId),
      "echo one",
    ]);
    assert.equal(rootPrompt.code, 0, rootPrompt.stderr);
    const rootBanner = rootPrompt.stderr
      .split("\n")
      .find((line) => line.startsWith("[acpx] session "));
    assert.ok(rootBanner?.includes(fx.root), rootPrompt.stderr);
    assert.equal(rootBanner?.includes("(routed from"), false, rootBanner);

    const legacyPrompt = await runCli(fx, [
      ...agentArgs(fx),
      "prompt",
      "--session-id",
      String(legacy.acpxRecordId),
      "echo two",
    ]);
    assert.equal(legacyPrompt.code, 0, legacyPrompt.stderr);
    const legacyBanner = legacyPrompt.stderr
      .split("\n")
      .find((line) => line.startsWith("[acpx] session "));
    assert.ok(legacyBanner?.includes("(routed from"), legacyBanner);
    assert.equal((await readRecord(fx, String(legacy.acpxRecordId))).cwd, fx.elsewhere);
  });
});

test("E7: the queue owner process stands in the root, not in the spawner's worktree", async () => {
  await withFixture(async (fx) => {
    const created = await createSession(fx);
    const id = String(created.acpxRecordId);
    const prompted = await runCli(fx, [
      ...agentArgs(fx),
      "--ttl",
      "30",
      "prompt",
      "--session-id",
      id,
      "echo warm",
    ]);
    assert.equal(prompted.code, 0, prompted.stderr);
    const { lockPath } = queuePaths(fx.homeDir, id);
    const pid = (JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number }).pid;
    assert.equal(readlinkSync(`/proc/${pid}/cwd`), fx.root);
  });
});

test("C5: help no longer says a session belongs to the current cwd or that --cwd places it", async () => {
  await withFixture(async (fx) => {
    for (const args of [["--help"], ["sessions", "new", "--help"], ["sessions", "--help"]]) {
      const help = await runCli(fx, args);
      const text = help.stdout + help.stderr;
      for (const stale of [
        "for current cwd",
        "Combine with --cwd",
        "where the new session lives",
      ]) {
        assert.equal(text.includes(stale), false, `${args.join(" ")}: ${stale}`);
      }
    }
  });
});

test("D4/E5 (Claude, D6): a copy of a legacy session whose folder is gone stages, forks at the root, leaves no stray", async () => {
  await withFixture(async (fx) => {
    const claudeArgs = [
      "--agent",
      `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --supports-fork-session --operation-log ${JSON.stringify(fx.opsLog)}`,
      "--approve-all",
    ];
    const noPrimer = { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" };
    const gone = path.join(fx.elsewhere, "gone-claude");
    await fs.mkdir(gone);
    const created = await runCli(
      fx,
      [...claudeArgs, "--cwd", gone, "--format", "json", "sessions", "new"],
      { env: { ...noPrimer, ACPX_SESSION_ROOT: "" } },
    );
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const createdResult = parseResult(created.stdout);
    const sourceId = String(createdResult.acpxRecordId);
    const prompted = await runCli(
      fx,
      [...claudeArgs, "prompt", "--session-id", sourceId, "echo remember-the-codeword"],
      { env: { ...noPrimer, ACPX_SESSION_ROOT: "" } },
    );
    assert.equal(prompted.code, 0, prompted.stdout + prompted.stderr);
    // Read AFTER the turn: this mock cannot load a session, so the first turn re-creates its ACP
    // session and the id moves. The on-disk record is snake_case (`acp_session_id`).
    const acpSessionId = String((await readRecord(fx, sourceId)).acp_session_id);
    assert.match(acpSessionId, /^[0-9a-f-]{36}$/);
    assert.ok(createdResult.acpxSessionId, "the create reported an ACP session id");
    const configDir = path.join(fx.homeDir, ".claude");
    const { transcriptJsonlPath } = await import("../src/config/subscription-transcript.js");
    const sourceTranscript = transcriptJsonlPath(configDir, gone, acpSessionId);
    const stagedPath = transcriptJsonlPath(configDir, fx.root, acpSessionId);
    await fs.mkdir(path.dirname(sourceTranscript), { recursive: true });
    const transcript = `${JSON.stringify({ type: "user", uuid: "u-1", message: { content: "hi" } })}\n`;
    await fs.writeFile(sourceTranscript, transcript);
    await fs.rm(gone, { recursive: true, force: true });

    const copied = await runCli(
      fx,
      [...claudeArgs, "--format", "json", "sessions", "copy", "--from", sourceId],
      { env: { ...noPrimer, ACPX_SESSION_ROOT: fx.root } },
    );
    assert.equal(copied.code, 0, copied.stdout + copied.stderr);
    assert.equal(parseResult(copied.stdout).cwd, fx.root);
    const fork = (await readOps(fx)).findLast((op) => op.method === "session/fork");
    assert.equal(
      fork?.cwd,
      fx.root,
      "the fork request ran at the destination, not the gone folder",
    );
    assert.equal(fork?.claudeTranscriptAtRequestCwd, true, "the source was staged for the fork");
    assert.equal(existsSync(stagedPath), false, "the staged copy was removed afterwards");
    assert.equal(existsSync(`${stagedPath}.acpx-stage.lock`), false, "the stage lock was released");
    assert.equal(
      await fs.readFile(sourceTranscript, "utf8"),
      transcript,
      "the source is unchanged",
    );
    assert.equal(existsSync(gone), false, "the gone folder was not re-created");
  });
});

test("F1 (real spawn): the adapter process gets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 over an inherited 0", async () => {
  await withFixture(async (fx) => {
    const dump = path.join(fx.elsewhere, "env.json");
    const created = await runCli(
      fx,
      [
        "--agent",
        `node ${JSON.stringify(MOCK_AGENT_PATH)} --env-dump-file ${JSON.stringify(dump)} --env-dump-extra CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
      ],
      { env: { ACPX_SESSION_ROOT: fx.root, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } },
    );
    assert.equal(created.code, 0, created.stderr);
    const env = JSON.parse(await fs.readFile(dump, "utf8")) as Record<string, string>;
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  });
});

async function recordCount(fx: Fixture): Promise<number> {
  const names = await fs.readdir(path.join(fx.homeDir, ".acpx", "sessions"));
  return names.filter((name) => name.endsWith(".json") && name !== "index.json").length;
}

/** A Pi-CLASSIFIED mock: acpx's real Pi path (provisioning, PI_CODING_AGENT_SESSION_DIR, staging). */
async function piMockArgs(fx: Fixture): Promise<string[]> {
  const dir = path.join(fx.elsewhere, "pi-acp");
  await fs.mkdir(dir, { recursive: true });
  const entry = path.join(dir, "index.js");
  if (!existsSync(entry)) {
    await fs.symlink(MOCK_AGENT_PATH, entry);
  }
  return [
    "--agent",
    `node ${JSON.stringify(entry)} --supports-fork-session --operation-log ${JSON.stringify(fx.opsLog)}`,
    "--approve-all",
  ];
}

/**
 * A legacy Pi session with one turn, and its pi JSONL planted in the box store under its own cwd's
 * slug dir — the shape pi itself leaves (`<ISO>_<id>.jsonl`, `type:"session"` header first).
 */
async function plantPiSource(
  fx: Fixture,
  cwd: string,
  header?: string,
): Promise<{ id: string; jsonl: string; content: string }> {
  const args = await piMockArgs(fx);
  const off = { env: { ACPX_SESSION_ROOT: "" } };
  const created = await runCli(
    fx,
    [...args, "--cwd", cwd, "--format", "json", "sessions", "new"],
    off,
  );
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const id = String(parseResult(created.stdout).acpxRecordId);
  const turn = await runCli(fx, [...args, "prompt", "--session-id", id, "echo planted"], off);
  assert.equal(turn.code, 0, turn.stdout + turn.stderr);
  const acpSessionId = String((await readRecord(fx, id)).acp_session_id);
  const { piBoxSessionDirFor } = await import("../src/acp/harness-config-dir.js");
  const dir = piBoxSessionDirFor(cwd, { HOME: fx.homeDir });
  await fs.mkdir(dir, { recursive: true });
  const jsonl = path.join(dir, `2026-11-06T00-00-00-000Z_${acpSessionId}.jsonl`);
  const content =
    `${header ?? JSON.stringify({ type: "session", version: 3, id: acpSessionId, timestamp: "2026-11-06T00:00:00.000Z", cwd })}\n` +
    `${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "PLANTED-CODEWORD" } })}\n`;
  await fs.writeFile(jsonl, content);
  return { id, jsonl, content };
}

test("E6/D8b/D8d (Pi, D7): a staged copy of a source whose folder is gone starts and lands at the root", async () => {
  await withFixture(async (fx) => {
    const gone = path.join(fx.elsewhere, "gone-pi");
    await fs.mkdir(gone);
    const source = await plantPiSource(fx, gone);
    await fs.rm(gone, { recursive: true, force: true });

    const copied = await runCli(fx, [
      ...(await piMockArgs(fx)),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      source.id,
    ]);
    assert.equal(copied.code, 0, copied.stdout + copied.stderr);
    const copy = parseResult(copied.stdout);
    assert.equal(copy.cwd, fx.root);
    const fork = (await readOps(fx)).findLast((op) => op.method === "session/fork");
    assert.equal(fork?.cwd, fx.root, "the fork ran at the destination");
    // What pi-acp read at fork time: the STAGED source, its header naming the destination.
    assert.equal(fork?.piStagedHeaderCwd, fx.root);
    // D8b: the source is byte-identical (still naming the legacy folder); nothing staged is left.
    assert.equal(await fs.readFile(source.jsonl, "utf8"), source.content);
    const { piBoxSessionDirFor } = await import("../src/acp/harness-config-dir.js");
    const rootDir = piBoxSessionDirFor(fx.root, { HOME: fx.homeDir });
    const leftovers = (await fs.readdir(rootDir).catch(() => [] as string[])).filter(
      (name) => name === path.basename(source.jsonl) || name.endsWith(".acpx-stage.lock"),
    );
    assert.deepEqual(leftovers, []);
    // The copy is a working session at the root: its next turn runs.
    const next = await runCli(fx, [
      ...(await piMockArgs(fx)),
      "prompt",
      "--session-id",
      String(copy.acpxRecordId),
      "echo after",
    ]);
    assert.equal(next.code, 0, next.stdout + next.stderr);
    assert.equal(existsSync(gone), false, "the gone folder was not re-created");
  });
});

test("D8c: a Pi source whose header cannot be rewritten is refused SOURCE_TRANSCRIPT_MISSING; nothing is created", async () => {
  await withFixture(async (fx) => {
    const legacyDir = path.join(fx.elsewhere, "legacy-pi");
    await fs.mkdir(legacyDir);
    const source = await plantPiSource(fx, legacyDir, "this is not a pi session header");
    const before = await recordCount(fx);
    const copied = await runCli(fx, [
      ...(await piMockArgs(fx)),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      source.id,
    ]);
    assert.notEqual(copied.code, 0);
    const output = copied.stdout + copied.stderr;
    assert.match(output, /SOURCE_TRANSCRIPT_MISSING/);
    assert.ok(output.includes(source.jsonl), "the refusal names the file");
    assert.equal(await recordCount(fx), before, "no record was created");
    assert.equal(
      await fs.readFile(source.jsonl, "utf8"),
      source.content,
      "the source is untouched",
    );
  });
});

test("D8c: a cross-cwd Pi copy whose source JSONL is in no store is refused SOURCE_TRANSCRIPT_MISSING", async () => {
  await withFixture(async (fx) => {
    const legacyDir = path.join(fx.elsewhere, "legacy-pi-nojsonl");
    await fs.mkdir(legacyDir);
    const source = await plantPiSource(fx, legacyDir);
    await fs.rm(source.jsonl);
    const before = await recordCount(fx);
    const copied = await runCli(fx, ["--format", "json", "sessions", "copy", "--from", source.id]);
    assert.notEqual(copied.code, 0);
    assert.match(copied.stdout + copied.stderr, /SOURCE_TRANSCRIPT_MISSING/);
    assert.equal(
      (copied.stdout + copied.stderr).includes("unknown session"),
      false,
      "never the adapter's unexplained 'unknown session'",
    );
    assert.equal(await recordCount(fx), before, "no record was created");
  });
});

test("E1 (warm owner): a folder deleted while the owner is warm is refused at the next turn start", async () => {
  await withFixture(async (fx) => {
    const gone = path.join(fx.elsewhere, "gone-warm");
    await fs.mkdir(gone);
    const off = { env: { ACPX_SESSION_ROOT: "" } };
    const legacy = await createSession(fx, ["--cwd", gone], off);
    const id = String(legacy.acpxRecordId);
    const warmTurn = await runCli(
      fx,
      [...agentArgs(fx), "--ttl", "60", "prompt", "--session-id", id, "echo warm"],
      off,
    );
    assert.equal(warmTurn.code, 0, warmTurn.stdout + warmTurn.stderr);
    // Planted positive: the owner (and its adapter) is ALIVE — the next turn takes no spawn.
    const { lockPath } = queuePaths(fx.homeDir, id);
    const ownerPid = (JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number }).pid;
    process.kill(ownerPid, 0);
    await fs.rm(gone, { recursive: true, force: true });

    const prompted = await runCli(
      fx,
      [...agentArgs(fx), "--format", "json", "prompt", "--session-id", id, "hello"],
      off,
    );
    assert.notEqual(prompted.code, 0, prompted.stdout + prompted.stderr);
    const output = prompted.stdout + prompted.stderr;
    assert.match(output, /SESSION_CWD_MISSING/);
    assert.ok(
      output.includes(`cannot start: its working directory ${gone} no longer exists`),
      output,
    );
    assert.equal(existsSync(gone), false, "the folder must NOT be re-created");
    const prompts = (await readOps(fx)).filter(
      (op) => op.method === "session/prompt" && op.text === "hello",
    );
    assert.deepEqual(prompts, [], "the refused turn never reached the agent");

    // E1u: the warm adapter is RELEASED (the owner recycles after the refused task) …
    const deadline = Date.now() + 20_000;
    let ownerAlive = true;
    while (ownerAlive && Date.now() < deadline) {
      try {
        process.kill(ownerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch {
        ownerAlive = false;
      }
    }
    assert.equal(ownerAlive, false, "the warm owner (and its adapter) must be released");

    // … and a DELIVERY (atrium's shape: a message id, no waiter) gets its own terminal with the
    // code — never the generic QUEUE_TURN_START_FAILED.
    const messageId = "5e1d0c3a-0000-4000-8000-0000000000e1";
    const delivered = await runCli(
      fx,
      [...agentArgs(fx), "prompt", "--session-id", id, "--no-wait", "--message-id", messageId, "x"],
      off,
    );
    const sessionsDir = path.join(fx.homeDir, ".acpx", "sessions");
    const carrying = async (needle: string): Promise<string[]> => {
      const hits: string[] = [];
      for (const name of await fs.readdir(sessionsDir)) {
        if (!name.startsWith(id)) {
          continue;
        }
        const body = await fs.readFile(path.join(sessionsDir, name), "utf8").catch(() => "");
        if (body.includes(needle)) {
          hits.push(name);
        }
      }
      return hits;
    };
    const terminalDeadline = Date.now() + 20_000;
    let terminal: string | undefined;
    while (!terminal && Date.now() < terminalDeadline) {
      for (const name of await carrying(messageId)) {
        const lines = (await fs.readFile(path.join(sessionsDir, name), "utf8")).split("\n");
        terminal = lines.find((line) => line.includes(messageId) && line.includes('"failed"'));
      }
      if (!terminal) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(terminal, `no failed delivery terminal: ${delivered.stdout}${delivered.stderr}`);
    assert.match(terminal, /SESSION_CWD_MISSING/);
    assert.equal(terminal.includes("QUEUE_TURN_START_FAILED"), false, terminal);
    assert.ok((await carrying("SESSION_CWD_MISSING")).length >= 1, "the record's turn error");
    assert.equal(existsSync(gone), false);
  });
});

// brick 45917618 (HoD ruling 2026-11-06; test-engineer finding B11, brick 8cf859f0). The REAL Claude
// adapter resumes a conversation by id from any project folder, so a mock that "misses" proves
// nothing: these rows plant a REAL transcript file under a LEGACY folder's slug in the temp
// `~/.claude` and drive the real acpx CLI. The refusal is acpx's own, before any adapter is spawned.
const RESUME_TRANSCRIPT_ID = "59414ee9-0000-4000-8000-00000000b011";

function claudeResumeArgs(fx: Fixture): string[] {
  return [
    "--agent",
    `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --supports-resume-session --operation-log ${JSON.stringify(fx.opsLog)}`,
    "--approve-all",
  ];
}

async function plantLegacyClaudeTranscript(fx: Fixture, legacy: string): Promise<string> {
  const { transcriptJsonlPath } = await import("../src/config/subscription-transcript.js");
  const file = transcriptJsonlPath(path.join(fx.homeDir, ".claude"), legacy, RESUME_TRANSCRIPT_ID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({ type: "user", uuid: "u-1", sessionId: RESUME_TRANSCRIPT_ID, cwd: legacy, message: { role: "user", content: "Remember QUILL" } })}\n`,
  );
  return file;
}

const NO_PRIMER = { ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh" };

test("B11 (real transcript): a resume WITHOUT --cwd of a conversation filed under a legacy folder is refused; nothing written", async () => {
  await withFixture(async (fx) => {
    const legacy = path.join(fx.elsewhere, "legacy-claude-r");
    await fs.mkdir(legacy);
    await plantLegacyClaudeTranscript(fx, legacy);
    const before = await recordCount(fx).catch(() => 0);
    const resumed = await runCli(
      fx,
      [
        ...claudeResumeArgs(fx),
        "--format",
        "json",
        "sessions",
        "new",
        "--resume-session",
        RESUME_TRANSCRIPT_ID,
      ],
      { env: { ...NO_PRIMER, ACPX_SESSION_ROOT: fx.root } },
    );
    assert.notEqual(resumed.code, 0, resumed.stdout + resumed.stderr);
    const output = resumed.stdout + resumed.stderr;
    assert.ok(output.includes(`no such conversation was found for the folder ${fx.root}`), output);
    assert.ok(output.includes("pass --cwd <the conversation's original folder>"), output);
    assert.match(output, /NO_SESSION/);
    assert.equal(await recordCount(fx).catch(() => 0), before, "no record was created");
    assert.equal(
      existsSync(path.join(fx.homeDir, ".acpx", "sessions", `${RESUME_TRANSCRIPT_ID}.json`)),
      false,
    );
    assert.deepEqual(await readOps(fx), [], "no adapter was even spawned");
  });
});

test("B10 + existing record (real transcript): WITH --cwd <its folder> it resumes there; a record never changes its folder", async () => {
  await withFixture(async (fx) => {
    const legacy = path.join(fx.elsewhere, "legacy-claude-r");
    await fs.mkdir(legacy);
    await plantLegacyClaudeTranscript(fx, legacy);
    const env = { env: { ...NO_PRIMER, ACPX_SESSION_ROOT: fx.root } };
    const resumeIn = (cwd: string | undefined) =>
      runCli(
        fx,
        [
          ...claudeResumeArgs(fx),
          ...(cwd === undefined ? [] : ["--cwd", cwd]),
          "--format",
          "json",
          "sessions",
          "new",
          "--resume-session",
          RESUME_TRANSCRIPT_ID,
        ],
        env,
      );

    const resumed = await resumeIn(legacy);
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    const result = parseResult(resumed.stdout);
    assert.equal(result.cwd, legacy, "the conversation keeps its folder");
    assert.equal(Object.hasOwn(result, "requestedCwd"), false, "nothing was overridden");
    assert.deepEqual(inertLines(resumed.stderr), [], "an honoured --cwd is not announced as inert");
    assert.equal((await readRecord(fx, String(result.acpxRecordId))).cwd, legacy);
    const resume = (await readOps(fx)).findLast((op) => op.method === "session/resume");
    assert.equal(resume?.cwd, legacy, "the agent was asked to resume it in that folder");

    // The existing record is never re-pointed: neither by --cwd elsewhere …
    const moved = await resumeIn(fx.worktree);
    assert.notEqual(moved.code, 0, moved.stdout + moved.stderr);
    assert.match(moved.stdout + moved.stderr, /RESUME_CWD_MISMATCH/);
    assert.ok((moved.stdout + moved.stderr).includes(`already exists in the folder ${legacy}`));
    // … nor by the root default.
    const rooted = await resumeIn(undefined);
    assert.notEqual(rooted.code, 0, rooted.stdout + rooted.stderr);
    assert.equal(
      (await readRecord(fx, RESUME_TRANSCRIPT_ID)).cwd,
      legacy,
      "the record kept its folder",
    );
  });
});

test("resume (Pi): a conversation whose JSONL is not under the chosen folder is refused; under it, it resumes", async () => {
  await withFixture(async (fx) => {
    const legacy = path.join(fx.elsewhere, "legacy-pi-r");
    await fs.mkdir(legacy);
    const dir = path.join(fx.elsewhere, "pi-acp");
    await fs.mkdir(dir, { recursive: true });
    const entry = path.join(dir, "index.js");
    if (!existsSync(entry)) {
      await fs.symlink(MOCK_AGENT_PATH, entry);
    }
    const args = [
      "--agent",
      `node ${JSON.stringify(entry)} --supports-resume-session --operation-log ${JSON.stringify(fx.opsLog)}`,
      "--approve-all",
    ];
    const id = "01a1b33d-0000-7000-8000-00000000b011";
    const { piBoxSessionDirFor } = await import("../src/acp/harness-config-dir.js");
    const boxDir = piBoxSessionDirFor(legacy, { HOME: fx.homeDir });
    await fs.mkdir(boxDir, { recursive: true });
    await fs.writeFile(
      path.join(boxDir, `2026-11-06T00-00-00-000Z_${id}.jsonl`),
      `${JSON.stringify({ type: "session", id, cwd: legacy })}\n`,
    );
    const missed = await runCli(fx, [
      ...args,
      "--format",
      "json",
      "sessions",
      "new",
      "--resume-session",
      id,
    ]);
    assert.notEqual(missed.code, 0);
    assert.ok(
      (missed.stdout + missed.stderr).includes(
        `no such conversation was found for the folder ${fx.root}`,
      ),
    );
    const found = await runCli(fx, [
      ...args,
      "--cwd",
      legacy,
      "--format",
      "json",
      "sessions",
      "new",
      "--resume-session",
      id,
    ]);
    assert.equal(found.code, 0, found.stdout + found.stderr);
    assert.equal(parseResult(found.stdout).cwd, legacy);
  });
});
