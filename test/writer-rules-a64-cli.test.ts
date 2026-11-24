// A-64 / C3.5 (ii), row 64.1 — the PRODUCTION arm: a real `acpx sessions close` (real CLI, real queue
// owners, the repo's mock ACP agent) whose stop finds a SUCCESSOR owner with its own adapter. Brought over
// from the abee5465 TE's real-CLI row (its L-d), with the pid assertions the TE measured and the fix flips.
//
// Owner A is alive when the close reads the record and the owner generation; the close is held at its
// SECOND owner connect (the drain, after both reads) by the test-only `--import` seam
// (close-hold-hook.ts); A idle-releases; a real `acpx prompt` spawns owner B, whose adapter runs a whole
// turn and writes its own pid on the record; then the close resumes. It signals A's adapter (its first
// read), finds B ≠ A and writes the scalars only — and must leave B's adapter its pid and identity.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRecordedPidPossiblyAlive, parseRecordPidIdentity } from "../src/process-identity.js";
import { queuePaths } from "./queue-test-helpers.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const HOOK_URL = new URL("./close-hold-hook.js", import.meta.url).href;
const AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --claude-agent-acp`;
const EMPTY_BRICK_POOL = path.join(os.tmpdir(), "acpx-a64-empty-brick-pool");

type Finished = { code: number | null; stdout: string; stderr: string };
type Running = { child: ChildProcess; done: Promise<Finished> };
type RawRecord = { closed?: boolean; closed_at?: string; pid?: number; pid_identity?: unknown };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function start(homeDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Running {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_BRICK_POOL_DIR: EMPTY_BRICK_POOL,
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
    [CLI_PATH, "--agent", AGENT, "--approve-all", "--cwd", cwd, ...args],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<Finished>((resolve) =>
    child.once("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
}

const run = async (homeDir: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  await start(homeDir, args, env).done;

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const recordFile = (homeDir: string, id: string) =>
  path.join(homeDir, ".acpx", "sessions", `${id}.json`);
const readRecord = (homeDir: string, id: string) =>
  JSON.parse(fs.readFileSync(recordFile(homeDir, id), "utf8")) as RawRecord;

function lease(homeDir: string, id: string): { pid: number } | null {
  try {
    return JSON.parse(fs.readFileSync(queuePaths(homeDir, id).lockPath, "utf8")) as { pid: number };
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID-only cleanup of the owners a row started, in its own temp home. */
function killOwner(homeDir: string, id: string, extra?: { pid: number }) {
  for (const owner of [lease(homeDir, id), extra ?? null]) {
    if (owner && alive(owner.pid)) {
      process.kill(owner.pid, "SIGKILL");
    }
  }
}

test(
  "64.1: a real close whose stop finds a SUCCESSOR owner leaves the successor's adapter its pid and identity",
  { timeout: 300_000 },
  async () => {
    await withTempHome("acpx-a64-cli-", async (homeDir) => {
      const created = await run(homeDir, ["--format", "json", "sessions", "new"]);
      assert.equal(created.code, 0, created.stderr);
      const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
      const q1 = await run(homeDir, [
        "--format",
        "quiet",
        "prompt",
        "--session-id",
        id,
        "echo A64-Q1-OWNER-A",
      ]);
      assert.equal(q1.code, 0, q1.stderr);
      const ownerA = lease(homeDir, id);
      assert.ok(ownerA && alive(ownerA.pid), "owner A is alive when the close starts");
      const adapterA = readRecord(homeDir, id).pid;

      const marker = path.join(homeDir, "close-held");
      const go = path.join(homeDir, "close-go");
      const close = start(homeDir, ["--format", "json", "sessions", "close", "--session-id", id], {
        A64_HOLD_MARKER: marker,
        A64_HOLD_GO: go,
        // connect #1 is the CLI handler's task-context query, BEFORE closeSession reads the record and the
        // owner generation; #2 is closeSession's drain, AFTER both reads.
        A64_HOLD_AT: "2",
        NODE_OPTIONS: `--import=${HOOK_URL}`,
      });
      let ownerB: { pid: number } | null = null;
      try {
        await waitUntil("the close to reach its drain", () => fs.existsSync(marker));

        // A idle-releases (3 s); then a real prompt spawns owner B (long idle) and runs a whole turn.
        await waitUntil(
          "owner A to release",
          () => lease(homeDir, id) === null && !alive(ownerA.pid),
          60_000,
        );
        const q2 = await run(
          homeDir,
          ["--format", "quiet", "prompt", "--session-id", id, "echo A64-Q2-REPLY-FROM-OWNER-B"],
          { ACPX_OWNER_IDLE_RELEASE_MS: "600000" },
        );
        assert.equal(q2.code, 0, q2.stderr);
        ownerB = lease(homeDir, id);
        assert.ok(
          ownerB && alive(ownerB.pid) && ownerB.pid !== ownerA.pid,
          "owner B is a live successor",
        );
        await sleep(500);
        const before = readRecord(homeDir, id);
        assert.equal(typeof before.pid, "number", "owner B's adapter wrote its pid on the record");
        assert.ok(before.pid_identity, "…and its identity");
        assert.notEqual(
          before.pid,
          adapterA,
          "…which is not owner A's adapter, the one the close signals",
        );
        assert.ok(alive(before.pid as number), "B's adapter is running");

        fs.writeFileSync(go, "");
        const closed = await close.done;
        const after = readRecord(homeDir, id);

        assert.equal(closed.code, 0, closed.stderr);
        assert.match(closed.stderr, /not proven stopped \(successor\)/);
        assert.equal(after.closed, true, "the close landed");
        assert.ok(after.closed_at);
        assert.equal(after.pid, before.pid, "B's adapter keeps its pid");
        assert.deepEqual(
          after.pid_identity,
          before.pid_identity,
          "…and its identity, byte for byte",
        );
        assert.ok(
          alive(ownerB.pid),
          "owner B is alive after the close (a successor is never signalled)",
        );
        assert.ok(alive(before.pid as number), "B's adapter is alive after the close");
        // The pid's readers (the archive's `pid-alive`, reconnect, export, dedup) see B's adapter.
        assert.equal(
          isRecordedPidPossiblyAlive(after.pid, parseRecordPidIdentity(after.pid_identity)),
          true,
          "the pid's readers see the running adapter",
        );
      } finally {
        killOwner(homeDir, id, ownerB ?? undefined);
      }
    });
  },
);

test(
  "64.1 (control): a real close of a session whose owner it stops clears the adapter's pid and identity",
  { timeout: 120_000 },
  async () => {
    await withTempHome("acpx-a64-cli-stopped-", async (homeDir) => {
      const created = await run(homeDir, ["--format", "json", "sessions", "new"]);
      assert.equal(created.code, 0, created.stderr);
      const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
      const q1 = await run(
        homeDir,
        ["--format", "quiet", "prompt", "--session-id", id, "echo A64-CONTROL"],
        {
          ACPX_OWNER_IDLE_RELEASE_MS: "600000",
        },
      );
      assert.equal(q1.code, 0, q1.stderr);
      try {
        const before = readRecord(homeDir, id);
        assert.equal(
          typeof before.pid,
          "number",
          "the live session's adapter pid is on the record",
        );
        assert.ok(before.pid_identity, "…with its identity");

        const closed = await run(homeDir, [
          "--format",
          "json",
          "sessions",
          "close",
          "--session-id",
          id,
        ]);
        assert.equal(closed.code, 0, closed.stderr);
        assert.doesNotMatch(closed.stderr, /not proven stopped/, "the owner was proven stopped");
        const after = readRecord(homeDir, id);
        assert.equal(after.closed, true);
        assert.equal(after.pid, undefined, "the stopped arm clears the pid");
        assert.equal(after.pid_identity, undefined, "…and the identity");
      } finally {
        killOwner(homeDir, id);
      }
    });
  },
);
