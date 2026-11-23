// A-60 / C3.5 — the independent TE's rows (brick f67e0ff1), beside the implementer's
// `writer-rules-a60-cli.test.ts`. Same production shape: the real CLI, a real queue owner woken by a
// real `acpx prompt`, a real `acpx sessions close`. They cover what that file does not:
//
// - TE.1 `--after-turn` from OUTSIDE on a HELD turn (no clock): `session_close_scheduled`, the close
//   happens at the turn's end, and the turn's final reply is in history once (C3.5 (ii) "unchanged").
// - TE.2 L-cancel through the real CLI (60.5 is record-level in the implementer's file): a turn that
//   streams AFTER the close started and does not settle within the 5 s drain keeps that late text.
// - TE.3 a dead owner's last streamed partial, then the next turn by a fresh owner: the partial is in
//   history once, BEFORE the next turn, and nothing stays inline once that turn is over.
// - TE.4 a self-close (`--now`) from inside a turn that has streamed a partial: the partial is in
//   history once (the implementer's visible effect (b)).
//
// Slow by nature: each row carries its own generous timeout.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queuePaths } from "./queue-test-helpers.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CONNECT_HOOK_URL = new URL("./a60-connect-hook.js", import.meta.url).href;
const AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --claude-agent-acp`;
const EMPTY_BRICK_POOL = path.join(os.tmpdir(), "acpx-a60-te-empty-brick-pool");
const ROW_TIMEOUT_MS = 300_000;

type Finished = { code: number | null; stdout: string; stderr: string };
type Running = { child: ChildProcess; done: Promise<Finished> };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function childEnv(homeDir: string, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_BRICK_POOL_DIR: EMPTY_BRICK_POOL,
    ACPX_OWNER_IDLE_RELEASE_MS: "3000",
    ...env,
  };
  for (const key of ["ACPX_SESSION_URL", "ACPX_SESSION_NAME", "ACPX_PARENT_SESSION_URL"]) {
    delete merged[key];
  }
  return merged;
}

function cliArgs(homeDir: string, args: string[]): string[] {
  const cwd = path.join(homeDir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  return [CLI_PATH, "--agent", AGENT, "--approve-all", "--cwd", cwd, ...args];
}

function start(homeDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(process.execPath, cliArgs(homeDir, args), {
    env: childEnv(homeDir, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
): Promise<Finished> {
  return await start(homeDir, args, env).done;
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

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

function recordPath(homeDir: string, id: string): string {
  return path.join(sessionsDir(homeDir), `${id}.json`);
}

function logOf(homeDir: string, id: string): string {
  const file = path.join(sessionsDir(homeDir), `${id}.messages.ndjson`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function recordText(homeDir: string, id: string): string {
  return fs.readFileSync(recordPath(homeDir, id), "utf8");
}

type DiskRecord = { closed?: boolean; messages?: unknown[] };

function diskRecord(homeDir: string, id: string): DiskRecord {
  return JSON.parse(recordText(homeDir, id)) as DiskRecord;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Where a mark lives: agent lines of the messages log (what a log-only reader, e.g. a search index, sees) vs inline. */
function placement(homeDir: string, id: string, mark: string): string {
  const inline = JSON.stringify(diskRecord(homeDir, id).messages ?? []);
  return `placement ${mark}: log=${count(agentLogText(logOf(homeDir, id)), mark)} inline=${count(inline, `"Text":"${mark}`)}`;
}

function assertEveryLogLineParses(log: string): void {
  assert.ok(log === "" || log.endsWith("\n"), "the log ends at a line boundary");
  for (const line of log.split("\n").filter((entry) => entry.length > 0)) {
    JSON.parse(line);
  }
}

type HistoryEntry = { role: "user" | "assistant"; textPreview: string };

/**
 * What a reader gets: the product's own `sessions read`, which must warn nothing. Returned as the
 * ASSISTANT entries' texts joined by a separator, in history order: the stream verbs echo their text
 * from the prompt, so a mark is counted only where the agent wrote it.
 */
async function readTranscript(homeDir: string, id: string): Promise<string> {
  const read = await run(homeDir, ["--format", "json", "sessions", "read", "--session-id", id]);
  assert.equal(read.code, 0, read.stderr);
  assert.doesNotMatch(read.stderr, /malformed|warning/i, "`sessions read` warns nothing");
  const entries = (JSON.parse(read.stdout.trim()) as { entries: HistoryEntry[] }).entries;
  assert.ok(entries.length > 0, "the reader saw a history (subject non-empty)");
  return entries
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.textPreview)
    .join("\n|ENTRY|\n");
}

/** The assistant entries of the log file, in order (raw lines whose role is Agent). */
function agentLogText(log: string): string {
  return log
    .split("\n")
    .filter((line) => line.startsWith('{"Agent"'))
    .join("\n");
}

async function newSession(homeDir: string): Promise<string> {
  const created = await run(homeDir, ["--format", "json", "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
  assert.equal(typeof id, "string");
  return id as string;
}

function prompt(homeDir: string, id: string, text: string): Running {
  return start(homeDir, ["--format", "quiet", "prompt", "--session-id", id, text]);
}

function ownerPid(homeDir: string, id: string): number {
  const lease = JSON.parse(fs.readFileSync(queuePaths(homeDir, id).lockPath, "utf8")) as {
    pid: number;
  };
  return lease.pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A held turn that has streamed `mark` and whose live checkpoint has published it inline. */
async function heldTurnWithInlinePartial(
  homeDir: string,
  id: string,
  verb: "stream-hold" | "stream-hold-late",
  mark: string,
): Promise<{ turn: Running; release: string }> {
  const release = path.join(homeDir, `release-${verb}`);
  const turn = prompt(homeDir, id, `${verb} ${release} ${mark}`);
  await waitUntil("the hold to engage", () => fs.existsSync(`${release}.holding`));
  // The agent's own entry (`"Text":"<mark>"`), never the User prompt that carries the mark too.
  await waitUntil("the partial to be inline", () =>
    recordText(homeDir, id).includes(`"Text":"${mark}"`),
  );
  return { turn, release };
}

// ---------------------------------------------------------------------------------------------
// TE.1 — `--after-turn` from OUTSIDE is unchanged: scheduled, closed at the turn's end, reply intact
// ---------------------------------------------------------------------------------------------

test(
  "TE.1: `sessions close --after-turn` from outside on a held turn answers session_close_scheduled, closes at the turn end, and keeps the final reply once",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-te-afterturn-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo Q1-WARM").done).code, 0);
      const { turn, release } = await heldTurnWithInlinePartial(
        homeDir,
        id,
        "stream-hold",
        "AT-PARTIAL",
      );
      const owner = ownerPid(homeDir, id);

      const scheduled = await run(homeDir, [
        "--format",
        "json",
        "sessions",
        "close",
        "--session-id",
        id,
        "--after-turn",
      ]);
      assert.equal(scheduled.code, 0, scheduled.stderr);
      const json = JSON.parse(scheduled.stdout.trim()) as Record<string, unknown>;
      assert.equal(json.action, "session_close_scheduled", scheduled.stdout);
      assert.equal(json.self, false);
      assert.equal(json.activeTurn, true);
      assert.equal(diskRecord(homeDir, id).closed, false, "nothing closed before the turn end");
      assert.ok(isAlive(owner), "the owner was not stopped by the scheduling");

      fs.writeFileSync(release, "");
      assert.equal((await turn.done).code, 0, "the held turn was not cut");
      await waitUntil("the deferred close", () => diskRecord(homeDir, id).closed === true);
      await waitUntil("the owner to exit", () => !isAlive(owner), 60_000);

      const log = logOf(homeDir, id);
      assertEveryLogLineParses(log);
      const agentLog = agentLogText(log);
      assert.equal(
        count(agentLog, "FINAL-AFTER-HOLD"),
        1,
        `the final reply is logged once:\n${log}`,
      );
      // The final entry carries the streamed partial and the final chunk; no stale partial beside it.
      assert.equal(count(agentLog, "AT-PARTIAL"), 2, `no separate partial entry:\n${log}`);
      const read = await readTranscript(homeDir, id);
      assert.equal(count(read, "FINAL-AFTER-HOLD"), 1, "`sessions read` shows the reply once");
      assert.equal(count(read, "AT-PARTIAL"), 2, "and no stale partial");
    });
  },
);

// ---------------------------------------------------------------------------------------------
// TE.2 — L-cancel through the real CLI: text streamed after the close started survives the close
// ---------------------------------------------------------------------------------------------

test(
  "TE.2 L-cancel: a default close of a turn that streams after the close started and never settles within the drain keeps the late text (red on b673d134)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-te-lcancel-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo Q1-WARM").done).code, 0);
      const { turn, release } = await heldTurnWithInlinePartial(
        homeDir,
        id,
        "stream-hold-late",
        "LC-PARTIAL",
      );
      const marker = path.join(homeDir, "close-connected");
      const close = start(homeDir, ["--format", "json", "sessions", "close", "--session-id", id], {
        A60_CONNECT_MARKER: marker,
        NODE_OPTIONS: `--import=${CONNECT_HOOK_URL}`,
      });
      // The close has read the record; its first connect to the owner comes next. The turn streams its
      // late chunk now and then never settles: the drain runs out and the stop ends the turn.
      await waitUntil("the close's first owner connect", () => fs.existsSync(marker));
      fs.writeFileSync(release, "");
      await waitUntil("the late chunk to be sent", () => fs.existsSync(`${release}.late-sent`));
      const closed = await close.done;
      assert.equal(closed.code, 0, closed.stderr);
      await turn.done;

      assert.equal(diskRecord(homeDir, id).closed, true);
      const log = logOf(homeDir, id);
      assertEveryLogLineParses(log);
      const read = await readTranscript(homeDir, id);
      assert.equal(
        count(read, "LATE-STREAM-LC-PARTIAL"),
        1,
        `the text streamed after the close started is in history once:\n${read}\nlog:\n${log}`,
      );
      assert.equal(count(agentLogText(log), "SETTLED-ON-ITS-OWN"), 0, "the turn never settled");
    });
  },
);

test(
  "TE.2 control: a close that reads the record after the late chunk was published keeps it once",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-te-lcancel-ctl-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo Q1-WARM").done).code, 0);
      const { turn, release } = await heldTurnWithInlinePartial(
        homeDir,
        id,
        "stream-hold-late",
        "LCC-PARTIAL",
      );
      fs.writeFileSync(release, "");
      await waitUntil("the late chunk to be inline", () =>
        recordText(homeDir, id).includes("LATE-STREAM-LCC-PARTIAL"),
      );
      // The close reads a record that already holds the late chunk.
      const closed = await run(homeDir, [
        "--format",
        "json",
        "sessions",
        "close",
        "--session-id",
        id,
      ]);
      assert.equal(closed.code, 0, closed.stderr);
      await turn.done;
      const read = await readTranscript(homeDir, id);
      assert.equal(count(read, "LATE-STREAM-LCC-PARTIAL"), 1, read);
    });
  },
);

// ---------------------------------------------------------------------------------------------
// TE.3 — a dead owner's last streamed partial, then the next turn by a fresh owner
// ---------------------------------------------------------------------------------------------

test(
  "TE.3: a dead owner's last inline partial is in history once, BEFORE the next turn, and nothing stays inline after that turn",
  { timeout: ROW_TIMEOUT_MS },
  async (t) => {
    await withTempHome("acpx-a60-te-deadowner-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo Q1-WARM").done).code, 0);
      const { turn, release } = await heldTurnWithInlinePartial(
        homeDir,
        id,
        "stream-hold",
        "DEAD-PARTIAL",
      );
      const owner = ownerPid(homeDir, id);
      process.kill(owner, "SIGKILL");
      await waitUntil("the owner to die", () => !isAlive(owner), 30_000);
      fs.writeFileSync(release, ""); // lets the orphaned mock adapter finish
      await turn.done;

      const next = await prompt(homeDir, id, "echo NEXT-TURN-MARK").done;
      assert.equal(next.code, 0, next.stderr);
      const later = await prompt(homeDir, id, "echo LATER-TURN-MARK").done;
      assert.equal(later.code, 0, later.stderr);

      const log = logOf(homeDir, id);
      assertEveryLogLineParses(log);
      t.diagnostic(placement(homeDir, id, "DEAD-PARTIAL"));
      const read = await readTranscript(homeDir, id);
      assert.equal(count(read, "DEAD-PARTIAL"), 1, `the dead owner's partial once:\n${read}`);
      assert.equal(count(read, "FINAL-AFTER-HOLD"), 0, "the killed turn never finished");
      assert.ok(
        read.indexOf("DEAD-PARTIAL") < read.indexOf("NEXT-TURN-MARK"),
        `the partial precedes the next turn in history:\n${read}`,
      );
      assert.ok(
        read.lastIndexOf("LATER-TURN-MARK") > read.lastIndexOf("DEAD-PARTIAL"),
        `the latest turn is the last thing in history:\n${read}`,
      );
      // The two later turns are over: nothing of the dead owner is left inline in the record.
      const inline = JSON.stringify(diskRecord(homeDir, id).messages ?? []);
      assert.equal(count(inline, "DEAD-PARTIAL"), 0, `no stale partial left inline: ${inline}`);
    });
  },
);

// ---------------------------------------------------------------------------------------------
// TE.4 — a self-close (`--now`) from inside a turn that has streamed a partial
// ---------------------------------------------------------------------------------------------

test(
  "TE.4: a self-close --now from inside a turn that has streamed a partial leaves that partial in history once",
  { timeout: ROW_TIMEOUT_MS },
  async (t) => {
    await withTempHome("acpx-a60-te-selfclose-", async (homeDir) => {
      const id = await newSession(homeDir);
      assert.equal((await prompt(homeDir, id, "echo Q1-WARM").done).code, 0);
      const flag = path.join(homeDir, "self-close-returned");
      const closeStderr = path.join(homeDir, "self-close.stderr");
      const close = cliArgs(homeDir, [
        "--verbose",
        "--format",
        "json",
        "sessions",
        "close",
        "--session-id",
        id,
        "--now",
      ])
        .map((part) => `'${part}'`)
        .join(" ");
      // The agent's own Bash: wait until the live checkpoint published the partial, then close itself.
      const script =
        `while ! grep -q SELF-PARTIAL '${recordPath(homeDir, id)}'; do sleep 0.05; done; ` +
        `'${process.execPath}' ${close} 2> '${closeStderr}'; touch '${flag}'`;
      const spec = { argv: ["sh", "-c", script], say: "NEVER-SAID", streamFirst: "SELF-PARTIAL" };
      const owner = ownerPid(homeDir, id);
      const turn = prompt(
        homeDir,
        id,
        `run-then-say ${Buffer.from(JSON.stringify(spec)).toString("base64url")}`,
      );
      await waitUntil("the record closed", () => diskRecord(homeDir, id).closed === true);
      await waitUntil("the owner to exit", () => !isAlive(owner), 60_000);
      await turn.done;
      // GUARD: the close took the SELF arm (written before it terminates its own owner).
      await waitUntil(
        "the self arm's verbose line",
        () =>
          fs.existsSync(closeStderr) &&
          fs.readFileSync(closeStderr, "utf8").includes("self-close:"),
      );

      const log = logOf(homeDir, id);
      assertEveryLogLineParses(log);
      t.diagnostic(placement(homeDir, id, "SELF-PARTIAL"));
      const read = await readTranscript(homeDir, id);
      assert.equal(count(read, "SELF-PARTIAL"), 1, `the partial is in history once:\n${read}`);
      assert.equal(count(read, "NEVER-SAID"), 0);
    });
  },
);
