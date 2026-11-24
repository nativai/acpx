// A-65 / C3.5 (iv) — the PRODUCTION-SHAPE rows (brick 5861c3d2): a real `acpx` CLI, a real queue owner woken by
// a real `acpx prompt`, a real `acpx sessions close` in both of its shapes, the verbs that write a record
// (`set-metadata`, `set`, `set-mode`, `sessions template`, `reopen`, `recover`), the session index, and a real
// `sessions copy`. Each plants a top-level key a newer release might add (and an unknown `metadata` key) in
// the record on disk, runs the writer, and reads the raw record back: the key and its value are unchanged.
//
// The planting goes through the record's own lock, as a newer release's write would, and — in the turn rows —
// AFTER the owner loaded its copy: the owner's copy never saw the key, so only a write that takes the unknown
// keys from the disk record (not from the copy) passes. Red at acpx agent-pods c88fccb1 (the turn rows, the
// closes of a proven-stopped owner, the set-* verbs).
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withRecordFileLock } from "../src/session/persistence/record-file-lock.js";
import { withTempHome } from "./runtime-test-helpers.js";
import { PLANTED, assertPlantedKept, type Raw } from "./unknown-top-level-fields-fixtures.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CONNECT_HOOK_URL = new URL("./a60-connect-hook.js", import.meta.url).href;
const AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --claude-agent-acp`;
const FORK_AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session`;
const ROW_TIMEOUT_MS = 300_000;

type Finished = { code: number | null; stdout: string; stderr: string };
type Running = { child: ChildProcess; done: Promise<Finished> };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function start(
  homeDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  agent: string = AGENT,
): Running {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_BRICK_POOL_DIR: path.join(homeDir, "empty-brick-pool"),
    ACPX_OWNER_IDLE_RELEASE_MS: "3000",
    ...env,
  };
  for (const key of ["ACPX_SESSION_URL", "ACPX_SESSION_NAME", "ACPX_PARENT_SESSION_URL"]) {
    delete childEnv[key];
  }
  const cwd = path.join(homeDir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.execPath,
    [CLI_PATH, "--agent", agent, "--approve-all", "--cwd", cwd, ...args],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<Finished>((resolve) => {
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function run(
  homeDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  agent: string = AGENT,
): Promise<Finished> {
  return await start(homeDir, args, env, agent).done;
}

async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sessionsDir = (homeDir: string): string => path.join(homeDir, ".acpx", "sessions");
const recordFile = (homeDir: string, id: string): string =>
  path.join(sessionsDir(homeDir), `${id}.json`);

function readRaw(homeDir: string, id: string): Raw {
  return JSON.parse(fs.readFileSync(recordFile(homeDir, id), "utf8")) as Raw;
}

async function newSession(homeDir: string, agent: string = AGENT): Promise<string> {
  const created = await run(homeDir, ["--format", "json", "sessions", "new"], {}, agent);
  assert.equal(created.code, 0, created.stderr);
  const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
  assert.equal(typeof id, "string");
  return id as string;
}

function prompt(homeDir: string, id: string, text: string): Running {
  return start(homeDir, ["--format", "quiet", "prompt", "--session-id", id, text]);
}

/** A newer release's write: the planted keys land in the record, under the record's own lock. */
async function plantUnderLock(homeDir: string, id: string): Promise<void> {
  const file = recordFile(homeDir, id);
  await withRecordFileLock(file, async () => {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Raw;
    for (const [key, value] of Object.entries(PLANTED)) {
      Object.defineProperty(raw, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    raw.metadata = { ...raw.metadata, te_unknown_meta: "meta-value" };
    const temporary = `${file}.plant.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(raw)}\n`);
    fs.renameSync(temporary, file);
  });
  assertPlantedKept(readRaw(homeDir, id), "after planting (positive control)");
}

async function holdTurn(
  homeDir: string,
  id: string,
  text: (release: string) => string,
): Promise<{ turn: Running; release: string }> {
  const release = path.join(homeDir, `release-${Math.random().toString(36).slice(2)}`);
  const turn = prompt(homeDir, id, text(release));
  await waitUntil("the hold to engage", () => fs.existsSync(`${release}.holding`));
  return { turn, release };
}

// ---------------------------------------------------------------------------------------------
// A real turn: the owner loaded its copy BEFORE the key existed
// ---------------------------------------------------------------------------------------------

test(
  "65.1 turn: a key planted while the owner's turn is held survives the owner's checkpoints and its turn end",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65-turn-", async (homeDir) => {
      const id = await newSession(homeDir);
      const { turn, release } = await holdTurn(homeDir, id, (file) => `hold-until-file ${file}`);
      await plantUnderLock(homeDir, id);
      fs.writeFileSync(release, "");
      const finished = await turn.done;
      assert.equal(finished.code, 0, finished.stderr);
      const raw = readRaw(homeDir, id);
      assert.ok(
        fs.readFileSync(path.join(sessionsDir(homeDir), `${id}.messages.ndjson`), "utf8").length >
          0,
        "control: the turn's own output is in the log",
      );
      assertPlantedKept(raw, "turn end");
    });
  },
);

test(
  "65.1 turn: the same with the turn streaming (live checkpoints after the key landed)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65-turn-stream-", async (homeDir) => {
      const id = await newSession(homeDir);
      const { turn, release } = await holdTurn(
        homeDir,
        id,
        (file) => `stream-hold ${file} PARTIAL-MARK`,
      );
      await waitUntil("the partial to be inline", () =>
        fs.readFileSync(recordFile(homeDir, id), "utf8").includes("PARTIAL-MARK"),
      );
      await plantUnderLock(homeDir, id);
      fs.writeFileSync(release, "");
      assert.equal((await turn.done).code, 0);
      assertPlantedKept(readRaw(homeDir, id), "streamed turn end");
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Both shapes of `acpx sessions close`
// ---------------------------------------------------------------------------------------------

test(
  "65.1 close: a default close of a session whose turn ended keeps them (the owner proven stopped)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65-close-after-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo hello").done).code, 0);
      await plantUnderLock(homeDir, id);
      const closed = await run(homeDir, [
        "--format",
        "json",
        "sessions",
        "close",
        "--session-id",
        id,
      ]);
      assert.equal(closed.code, 0, closed.stderr);
      const raw = readRaw(homeDir, id);
      assert.equal(raw.closed, true, "control: the close landed");
      assertPlantedKept(raw, "close after the turn");
    });
  },
);

test(
  "65.1 close: a close of a session whose owner is mid-turn keeps them (the owner's later write and the close's)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65-close-mid-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo warm").done).code, 0);
      const { turn, release } = await holdTurn(
        homeDir,
        id,
        (file) => `stream-hold ${file} PARTIAL-MARK`,
      );
      await waitUntil("the partial to be inline", () =>
        fs.readFileSync(recordFile(homeDir, id), "utf8").includes("PARTIAL-MARK"),
      );
      await plantUnderLock(homeDir, id);
      const marker = path.join(homeDir, "close-connected");
      const close = start(homeDir, ["--format", "json", "sessions", "close", "--session-id", id], {
        A60_CONNECT_MARKER: marker,
        NODE_OPTIONS: `--import=${CONNECT_HOOK_URL}`,
      });
      await waitUntil("the close's first owner connect", () => fs.existsSync(marker));
      fs.writeFileSync(release, "");
      const closed = await close.done;
      assert.equal(closed.code, 0, closed.stderr);
      await turn.done;
      const raw = readRaw(homeDir, id);
      assert.equal(raw.closed, true, "control: the close landed");
      assertPlantedKept(raw, "close mid-turn");
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The verbs that write a record, in one session's life
// ---------------------------------------------------------------------------------------------

test(
  "65.1 verbs: set-metadata, set, set-mode, template, reopen and recover each keep them, and the index never shows them",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65-verbs-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo hello").done).code, 0);
      await plantUnderLock(homeDir, id);

      const verbs: Array<{ name: string; args: string[]; own: (raw: Raw) => boolean }> = [
        {
          name: "set-metadata",
          args: ["sessions", "set-metadata", "te_own_key", "own-value", "--session-id", id],
          own: (raw) => raw.metadata?.te_own_key === "own-value",
        },
        {
          name: "set (model)",
          args: ["set", "model", "gpt-5.4", "--session-id", id],
          own: (raw) => JSON.stringify(raw.acpx).includes("gpt-5.4"),
        },
        {
          name: "set-mode",
          args: ["set-mode", "plan", "--session-id", id],
          own: (raw) => JSON.stringify(raw.acpx).includes('"plan"'),
        },
        {
          name: "recover",
          args: ["sessions", "recover", id],
          own: () => true,
        },
        {
          name: "template",
          args: ["sessions", "template", id, "--enable"],
          own: (raw) => typeof raw.template === "object" && raw.template !== null,
        },
        {
          name: "close then reopen",
          args: ["sessions", "reopen", id],
          own: () => true,
        },
      ];
      for (const verb of verbs) {
        if (verb.name === "close then reopen") {
          const closed = await run(homeDir, ["sessions", "close", "--session-id", id]);
          assert.equal(closed.code, 0, closed.stderr);
          assertPlantedKept(readRaw(homeDir, id), "close before reopen");
        }
        const result = await run(homeDir, verb.args);
        assert.equal(result.code, 0, `${verb.name}: ${result.stdout}${result.stderr}`);
        const raw = readRaw(homeDir, id);
        assert.ok(verb.own(raw), `${verb.name}: its own change is on disk`);
        assertPlantedKept(raw, verb.name);
      }

      // The index: positive control (the session is in it), then no planted key in it.
      const reindexed = await run(homeDir, ["sessions", "reindex"]);
      assert.equal(reindexed.code, 0, reindexed.stderr);
      const index = fs.readFileSync(path.join(sessionsDir(homeDir), "index.json"), "utf8");
      assert.ok(index.includes(id), "control: the session is in the index");
      for (const key of Object.keys(PLANTED).filter((name) => name.length > 0)) {
        assert.ok(!index.includes(JSON.stringify(key)), `the index leaks ${key}`);
      }
      // And the camelCase JSON the CLI prints for the record shows none of them.
      const shown = await run(homeDir, [
        "--format",
        "json",
        "sessions",
        "show",
        "--session-id",
        id,
      ]);
      assert.equal(shown.code, 0, shown.stderr);
      for (const key of Object.keys(PLANTED).filter((name) => name.length > 0)) {
        assert.ok(!shown.stdout.includes(JSON.stringify(key)), `sessions show leaks ${key}`);
      }
    });
  },
);

// ---------------------------------------------------------------------------------------------
// DECISION (the sub-HoD's, 2026-11-24): a fork is a new session and does not carry the source's keys
// ---------------------------------------------------------------------------------------------

test(
  "65.6 copy: a real `sessions copy` does not carry the source's unknown keys (the new record has none, the source keeps them)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65-copy-", async (homeDir) => {
      const id = await newSession(homeDir, FORK_AGENT);
      await plantUnderLock(homeDir, id);
      const copied = await run(
        homeDir,
        ["--format", "json", "sessions", "copy", "--from", id, "--ephemeral"],
        {},
        FORK_AGENT,
      );
      assert.equal(copied.code, 0, `${copied.stdout}${copied.stderr}`);
      const childId = (JSON.parse(copied.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
      assert.ok(childId && childId !== id);
      const child = readRaw(homeDir, childId);
      assert.equal(child.forked_from_session_id, id, "control: it is the fork of the source");
      for (const key of Object.keys(PLANTED)) {
        assert.ok(!Object.hasOwn(child, key), `the fork carries ${JSON.stringify(key)}`);
      }
      assert.equal(
        child.metadata?.te_unknown_meta,
        undefined,
        "the unknown metadata key is not copied",
      );
      assertPlantedKept(readRaw(homeDir, id), "copy source");
    });
  },
);
