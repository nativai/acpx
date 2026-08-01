import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * brick://be4a45ae — session-by-name resolution must fail closed.
 *
 * `findSession` and `findSessionByDirectoryWalk` used to be a plain
 * `Array.find` over an index ordered by `lastUsedAt` descending: on duplicate
 * `(name, cwd, agent)` they silently returned the most recently used session,
 * and every misdelivery refreshed that winner's recency, so it kept absorbing
 * the other session's traffic. They now fail closed, like every sibling
 * resolver in `repository.ts`.
 */

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

const AGENT = "agent-a";

// ---------------------------------------------------------------------------
// Unit level — the two resolvers
// ---------------------------------------------------------------------------

test("findSession throws on co-located duplicate names instead of silently picking one", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "repo");
    await fs.mkdir(cwd, { recursive: true });

    await seedSession(homeDir, { id: "dup-older", cwd, name: "shared", lastUsedAt: OLD_TS });
    await seedSession(homeDir, { id: "dup-newer", cwd, name: "shared", lastUsedAt: NEW_TS });

    await assert.rejects(
      async () => await session.findSession({ agentCommand: AGENT, cwd, name: "shared" }),
      (error: unknown) => {
        assertNamesBothCandidates(error, cwd, ["dup-older", "dup-newer"], "shared");
        return true;
      },
    );
  });
});

test("findSessionByDirectoryWalk throws on co-located duplicate names", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const repoRoot = path.join(homeDir, "repo");
    const nested = path.join(repoRoot, "packages", "app");
    await fs.mkdir(nested, { recursive: true });

    await seedSession(homeDir, {
      id: "walk-older",
      cwd: repoRoot,
      name: "shared",
      lastUsedAt: OLD_TS,
    });
    await seedSession(homeDir, {
      id: "walk-newer",
      cwd: repoRoot,
      name: "shared",
      lastUsedAt: NEW_TS,
    });

    await assert.rejects(
      async () =>
        await session.findSessionByDirectoryWalk({
          agentCommand: AGENT,
          cwd: nested,
          name: "shared",
          boundary: repoRoot,
        }),
      (error: unknown) => {
        assertNamesBothCandidates(error, repoRoot, ["walk-older", "walk-newer"], "shared");
        return true;
      },
    );
  });
});

test("a deeper cwd still shadows duplicates in a parent directory (S2 regression guard)", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const repoRoot = path.join(homeDir, "repo");
    const nested = path.join(repoRoot, "packages", "app");
    await fs.mkdir(nested, { recursive: true });

    // Two duplicates at the SHALLOW level — a global uniqueness check would
    // throw here. Ambiguity is judged per directory level, so the walk never
    // reaches them: the deep match wins first, exactly as nested worktrees rely
    // on today.
    await seedSession(homeDir, {
      id: "shallow-a",
      cwd: repoRoot,
      name: "shared",
      lastUsedAt: NEW_TS,
    });
    await seedSession(homeDir, {
      id: "shallow-b",
      cwd: repoRoot,
      name: "shared",
      lastUsedAt: OLD_TS,
    });
    await seedSession(homeDir, { id: "deep", cwd: nested, name: "shared", lastUsedAt: OLD_TS });

    const walked = await session.findSessionByDirectoryWalk({
      agentCommand: AGENT,
      cwd: nested,
      name: "shared",
      boundary: repoRoot,
    });
    assert.equal(walked?.acpxRecordId, "deep");
  });
});

test("a unique name still resolves, directly and through the parent walk", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const repoRoot = path.join(homeDir, "repo");
    const nested = path.join(repoRoot, "packages", "app");
    await fs.mkdir(nested, { recursive: true });

    await seedSession(homeDir, { id: "only-one", cwd: repoRoot, name: "unique" });
    // A same-named session in an unrelated cwd must not make the walk ambiguous.
    await seedSession(homeDir, {
      id: "elsewhere",
      cwd: path.join(homeDir, "other"),
      name: "unique",
    });

    const direct = await session.findSession({
      agentCommand: AGENT,
      cwd: repoRoot,
      name: "unique",
    });
    assert.equal(direct?.acpxRecordId, "only-one");

    const walked = await session.findSessionByDirectoryWalk({
      agentCommand: AGENT,
      cwd: nested,
      name: "unique",
      boundary: repoRoot,
    });
    assert.equal(walked?.acpxRecordId, "only-one");
  });
});

test("the ambiguity message names every candidate record id and cwd and the next command", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "repo");
    await fs.mkdir(cwd, { recursive: true });

    await seedSession(homeDir, { id: "candidate-one", cwd, name: "shared" });
    await seedSession(homeDir, { id: "candidate-two", cwd, name: "shared" });

    const error = await session.findSession({ agentCommand: AGENT, cwd, name: "shared" }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof Error, "resolution must throw");
    const message = error.message;
    // The message is the feature: an operator must be able to act on it
    // without opening the source.
    assert.match(message, /Session name "shared" is ambiguous/);
    assert.match(message, new RegExp(`cwd: ${escapeRegExp(cwd)}; record ID: candidate-one`));
    assert.match(message, new RegExp(`cwd: ${escapeRegExp(cwd)}; record ID: candidate-two`));
    assert.match(message, /--session-id <id>/);
  });
});

// ---------------------------------------------------------------------------
// CLI level — the real binary against a real session store
// ---------------------------------------------------------------------------

test("the real CLI refuses an ambiguous name for prompt, sessions new and sessions ensure", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    // A genuinely live session, created through the real create path, so the
    // rig is proven capable of a successful delivery before we test refusal.
    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "twin",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const liveId = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // Its duplicate: same name, same cwd, same agent, but OLDER — so the
    // pre-fix `Array.find` over a lastUsedAt-descending index would have picked
    // the live one and delivered successfully. A regression is therefore
    // visible as a PASS of the old behaviour, not as an unrelated failure.
    await seedSession(homeDir, {
      id: "twin-shadow",
      cwd,
      name: "twin",
      agentCommand: MOCK_AGENT_COMMAND,
      lastUsedAt: OLD_TS,
    });

    const sentinel = "sentinel-payload-be4a45ae-must-not-be-delivered";
    const prompted = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "prompt",
        "-s",
        "twin",
        sentinel,
      ],
      homeDir,
    );
    assert.notEqual(prompted.code, 0, `an ambiguous name must not exit 0\n${describe(prompted)}`);
    assert.match(output(prompted), /is ambiguous/, describe(prompted));
    assert.match(output(prompted), new RegExp(escapeRegExp(liveId)), describe(prompted));
    assert.match(output(prompted), /twin-shadow/, describe(prompted));
    assert.match(output(prompted), new RegExp(escapeRegExp(cwd)), describe(prompted));
    assert.match(output(prompted), /--session-id <id>/, describe(prompted));

    // Nothing is delivered on ambiguity — to EITHER candidate. Scan the whole
    // store rather than one record: the payload must exist nowhere on disk.
    assert.deepEqual(
      await sessionFilesContaining(homeDir, sentinel),
      [],
      "the prompt body reached a session despite the ambiguity",
    );

    // `sessions new` used to soft-close whichever same-named session `find`
    // returned. It must refuse, and both candidates must stay open.
    const remade = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "twin",
      ],
      homeDir,
    );
    assert.notEqual(remade.code, 0, describe(remade));
    assert.match(output(remade), /is ambiguous/, describe(remade));
    assert.equal(await isClosed(homeDir, liveId), false, "sessions new closed a candidate anyway");
    assert.equal(await isClosed(homeDir, "twin-shadow"), false);

    // `sessions ensure` is the path that silently REUSES an arbitrary
    // same-named session — two spawners picking one child name would collapse
    // into a single session with no warning to either.
    const before = await listSessionRecordIds(homeDir);
    const ensured = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "ensure",
        "-s",
        "twin",
      ],
      homeDir,
    );
    assert.notEqual(ensured.code, 0, describe(ensured));
    assert.match(output(ensured), /is ambiguous/, describe(ensured));
    assert.deepEqual(
      await listSessionRecordIds(homeDir),
      before,
      "sessions ensure created or reused a session despite the ambiguity",
    );

    // Control: an unambiguous name on the same rig still resolves and delivers.
    const uniqueCreated = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "solo",
      ],
      homeDir,
    );
    assert.equal(uniqueCreated.code, 0, uniqueCreated.stderr);
    const soloSentinel = "sentinel-control-be4a45ae-must-be-delivered";
    const soloPrompt = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "prompt",
        "-s",
        "solo",
        soloSentinel,
      ],
      homeDir,
    );
    assert.equal(soloPrompt.code, 0, soloPrompt.stderr);
    assert.notDeepEqual(
      await sessionFilesContaining(homeDir, soloSentinel),
      [],
      "the control delivery never landed — the rig cannot prove the refusal above",
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OLD_TS = "2026-01-01T00:00:00.000Z";
const NEW_TS = "2026-06-01T00:00:00.000Z";

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(
    `${SESSION_MODULE_URL.href}?ambiguity_test=${cacheBuster}`
  )) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-name-ambiguity-", run);
}

async function seedSession(
  homeDir: string,
  options: {
    id: string;
    cwd: string;
    name: string;
    agentCommand?: string;
    lastUsedAt?: string;
  },
): Promise<void> {
  await fs.mkdir(options.cwd, { recursive: true });
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecordFixture(
      {
        acpxRecordId: options.id,
        acpSessionId: options.id,
        agentCommand: options.agentCommand ?? AGENT,
        cwd: options.cwd,
        name: options.name,
        lastUsedAt: options.lastUsedAt ?? OLD_TS,
      },
      { defaultName: false, defaultAcpx: false },
    ),
  );
  // Writing the record file by hand does not touch index.json, and the index is
  // only rebuilt when it is missing — so a seed added after the CLI has already
  // built an index would be invisible to every resolver.
  await fs.rm(path.join(sessionsDir(homeDir), "index.json"), { force: true });
}

function assertNamesBothCandidates(error: unknown, cwd: string, ids: string[], name: string): void {
  assert.ok(error instanceof Error);
  assert.match(error.message, new RegExp(`Session name "${escapeRegExp(name)}" is ambiguous`));
  for (const id of ids) {
    assert.match(error.message, new RegExp(`cwd: ${escapeRegExp(cwd)}; record ID: ${id}`));
  }
  assert.match(error.message, /--session-id <id>/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

async function listSessionRecordIds(homeDir: string): Promise<string[]> {
  const entries = await fs.readdir(sessionsDir(homeDir));
  return entries
    .filter((entry) => entry.endsWith(".json") && entry !== "index.json")
    .map((entry) => entry.slice(0, -".json".length))
    .toSorted();
}

async function isClosed(homeDir: string, id: string): Promise<boolean> {
  const raw = await fs.readFile(
    path.join(sessionsDir(homeDir), `${encodeURIComponent(id)}.json`),
    "utf8",
  );
  return (JSON.parse(raw) as { closed?: unknown }).closed === true;
}

/** Every file in the session store whose bytes contain `needle`. */
async function sessionFilesContaining(homeDir: string, needle: string): Promise<string[]> {
  const dir = sessionsDir(homeDir);
  const hits: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const raw = await fs.readFile(path.join(dir, entry.name), "utf8").catch(() => "");
    if (raw.includes(needle)) {
      hits.push(entry.name);
    }
  }
  return hits.toSorted();
}

type CliRunResult = { code: number | null; stdout: string; stderr: string };

/**
 * Everything the operator sees. Which stream carries the error depends on the
 * resolved output policy — a piped, non-TTY run emits a JSON-RPC error envelope
 * on stdout where an interactive run prints human text on stderr — so a test
 * that watches only one stream reports a false negative.
 */
function output(result: CliRunResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** Full transcript of a run, for assertion messages that have to be diagnosable. */
function describe(result: CliRunResult): string {
  return `exit=${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

async function runCli(args: string[], homeDir: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
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
    child.stdin.end();
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
