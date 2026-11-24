// A-65 correction (C3.5 (iv) "`metadata` keys", brick 1948e346) — the production-shape rows 65.4 and 65.5 through
// the REAL `acpx` CLI: a real queue owner woken by a real `acpx prompt`, the `set-*` verbs, the template verb,
// both shapes of `acpx sessions close`, export, and the refusals of `set-metadata` and `--metadata`.
//
// 65.4 plants `teMetaCamel` and `te_meta_ünï` in the record's `metadata` under the record's own lock, as a newer
// release (or a hand edit) would, and runs each writer; the keys are on disk afterwards, unchanged. Red at acpx
// agent-pods 33fc6460, where every writer exits 1 with `Persisted key policy violation`.
// 65.5 asks acpx to write a camelCase key itself; it refuses before any write and the record is byte-unchanged.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withRecordFileLock } from "../src/session/persistence/record-file-lock.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CONNECT_HOOK_URL = new URL("./a60-connect-hook.js", import.meta.url).href;
const AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --claude-agent-acp`;
const FORK_AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session`;
const ROW_TIMEOUT_MS = 300_000;

const CARRIED: Readonly<Record<string, string>> = {
  teMetaCamel: "camel-value",
  te_meta_ünï: "unicode-value",
};

type Raw = Record<string, unknown> & { metadata?: Record<string, string> };
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

function recordFiles(homeDir: string): string[] {
  return fs
    .readdirSync(sessionsDir(homeDir))
    .filter((name) => name.endsWith(".json") && name !== "index.json" && name !== "seats.json")
    .toSorted();
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

function assertCarried(raw: Raw, label: string): void {
  for (const [key, value] of Object.entries(CARRIED)) {
    assert.equal(raw.metadata?.[key], value, `${label}: metadata ${JSON.stringify(key)}`);
  }
}

/** A newer release's (or a hand edit's) write: the keys land in `metadata`, under the record's own lock. */
async function plantUnderLock(homeDir: string, id: string): Promise<void> {
  const file = recordFile(homeDir, id);
  await withRecordFileLock(file, async () => {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Raw;
    raw.metadata = { ...raw.metadata, ...CARRIED };
    const temporary = `${file}.plant.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(raw)}\n`);
    fs.renameSync(temporary, file);
  });
  assertCarried(readRaw(homeDir, id), "after planting (positive control)");
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
// 65.4 — a carried non-snake_case `metadata` key is never a refusal
// ---------------------------------------------------------------------------------------------

test(
  "65.4 turn: a key planted while the owner's turn is held survives the owner's checkpoints and its turn end",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65m-turn-", async (homeDir) => {
      const id = await newSession(homeDir);
      const { turn, release } = await holdTurn(homeDir, id, (file) => `hold-until-file ${file}`);
      await plantUnderLock(homeDir, id);
      fs.writeFileSync(release, "");
      const finished = await turn.done;
      assert.equal(finished.code, 0, finished.stderr);
      assert.ok(
        fs.readFileSync(path.join(sessionsDir(homeDir), `${id}.messages.ndjson`), "utf8").length >
          0,
        "control: the turn's own output is in the log",
      );
      assertCarried(readRaw(homeDir, id), "turn end");
      // And the turns after it.
      assert.equal((await prompt(homeDir, id, "echo again").done).code, 0);
      assertCarried(readRaw(homeDir, id), "the next turn");
    });
  },
);

test(
  "65.4 close: a default close of a session whose turn ended keeps them (the owner proven stopped)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65m-close-after-", async (homeDir) => {
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
      assert.equal(closed.code, 0, `${closed.stdout}${closed.stderr}`);
      const raw = readRaw(homeDir, id);
      assert.equal(raw.closed, true, "control: the close landed");
      assertCarried(raw, "close after the turn");
    });
  },
);

test(
  "65.4 close: a close of a session whose owner is mid-turn keeps them (the owner not proven stopped)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65m-close-mid-", async (homeDir) => {
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
      assert.equal(closed.code, 0, `${closed.stdout}${closed.stderr}`);
      await turn.done;
      const raw = readRaw(homeDir, id);
      assert.equal(raw.closed, true, "control: the close landed");
      assertCarried(raw, "close mid-turn");
    });
  },
);

test(
  "65.4 verbs: set-metadata of another key, set, set-mode, template, close, reopen, recover and export each keep them",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65m-verbs-", async (homeDir) => {
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
        { name: "recover", args: ["sessions", "recover", id], own: () => true },
        {
          name: "template",
          args: ["sessions", "template", id, "--enable"],
          own: (raw) => typeof raw.template === "object" && raw.template !== null,
        },
        { name: "close then reopen", args: ["sessions", "reopen", id], own: () => true },
      ];
      for (const verb of verbs) {
        if (verb.name === "close then reopen") {
          const closed = await run(homeDir, ["sessions", "close", "--session-id", id]);
          assert.equal(closed.code, 0, `${closed.stdout}${closed.stderr}`);
          assertCarried(readRaw(homeDir, id), "close before reopen");
        }
        const result = await run(homeDir, verb.args);
        assert.equal(result.code, 0, `${verb.name}: ${result.stdout}${result.stderr}`);
        const raw = readRaw(homeDir, id);
        assert.ok(verb.own(raw), `${verb.name}: its own change is on disk`);
        assertCarried(raw, verb.name);
      }
      const archive = path.join(homeDir, "out.acpx.json");
      const exported = await run(homeDir, [
        "sessions",
        "export",
        "--session-id",
        id,
        "--output",
        archive,
      ]);
      assert.equal(exported.code, 0, `${exported.stdout}${exported.stderr}`);
      const state = (JSON.parse(fs.readFileSync(archive, "utf8")) as { session: { state: Raw } })
        .session.state;
      assertCarried(state, "export bundle");
    });
  },
);

// ---------------------------------------------------------------------------------------------
// 65.5 — acpx refuses a key of its own that breaks the rule, before any write
// ---------------------------------------------------------------------------------------------

test(
  "65.5 set-metadata: a camelCase or dashed key is refused before any write, naming key and rule; a snake_case key writes",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65m-set-", async (homeDir) => {
      const id = await newSession(homeDir);
      const file = recordFile(homeDir, id);
      const before = sha256(file);
      for (const key of ["teMetaCamel", "te-meta"]) {
        const refused = await run(homeDir, [
          "sessions",
          "set-metadata",
          key,
          "x",
          "--session-id",
          id,
        ]);
        assert.notEqual(refused.code, 0, `${key}: refused: ${refused.stdout}${refused.stderr}`);
        assert.ok(refused.stderr.includes(JSON.stringify(key)), `${key}: names the key`);
        assert.ok(refused.stderr.includes("^[a-z][a-z0-9_]*$"), `${key}: names the rule`);
        assert.equal(sha256(file), before, `${key}: the record is byte-unchanged`);
      }
      // Control, same verb, same session: a snake_case key writes as before.
      const written = await run(homeDir, [
        "sessions",
        "set-metadata",
        "te_meta",
        "x",
        "--session-id",
        id,
      ]);
      assert.equal(written.code, 0, `${written.stdout}${written.stderr}`);
      assert.equal(readRaw(homeDir, id).metadata?.te_meta, "x");
    });
  },
);

test(
  "65.5 --metadata: `sessions new` and `sessions copy` refuse a bad key before creating anything; a snake_case key creates",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a65m-new-", async (homeDir) => {
      const id = await newSession(homeDir, FORK_AGENT);
      const filesBefore = recordFiles(homeDir);
      assert.equal(
        filesBefore.length,
        1,
        `control: one session exists: ${JSON.stringify(filesBefore)}`,
      );
      const sourceBefore = sha256(recordFile(homeDir, id));

      const refusedNew = await run(
        homeDir,
        ["--format", "json", "sessions", "new", "--metadata", "teMetaCamel=x"],
        {},
        FORK_AGENT,
      );
      assert.notEqual(refusedNew.code, 0, `${refusedNew.stdout}${refusedNew.stderr}`);
      assert.ok(refusedNew.stderr.includes('"teMetaCamel"'), "new: names the key");
      assert.ok(refusedNew.stderr.includes("^[a-z][a-z0-9_]*$"), "new: names the rule");

      const refusedCopy = await run(
        homeDir,
        ["--format", "json", "sessions", "copy", "--from", id, "--metadata", "te-meta=x"],
        {},
        FORK_AGENT,
      );
      assert.notEqual(refusedCopy.code, 0, `${refusedCopy.stdout}${refusedCopy.stderr}`);
      assert.ok(refusedCopy.stderr.includes('"te-meta"'), "copy: names the key");

      assert.deepEqual(recordFiles(homeDir), filesBefore, "no session was created");
      assert.equal(sha256(recordFile(homeDir, id)), sourceBefore, "the source is byte-unchanged");

      // Control, same verb: a snake_case key creates the session with the key.
      const created = await run(
        homeDir,
        ["--format", "json", "sessions", "new", "--metadata", "te_meta=x"],
        {},
        FORK_AGENT,
      );
      assert.equal(created.code, 0, `${created.stdout}${created.stderr}`);
      const createdId = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string })
        .acpxRecordId;
      assert.equal(readRaw(homeDir, createdId).metadata?.te_meta, "x");
    });
  },
);
