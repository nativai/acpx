// Shared rig pieces for the session-index `closed` monotonicity rows (brick 19ee17ab):
// a LIVE index-lock holder, a seeded session store, and a line-reader for child processes.
//
// Not a test file (no `.test.` in the name) — imported by the test files that need it.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import { sessionIndexLockPath } from "../src/session/persistence/index-lock.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "../src/session/persistence/index.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

export function sessionsDirOf(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

export function recordFileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.json`;
}

/**
 * Seed a store with OPEN records AND a matching index (one open entry each), so a later
 * index read sees no membership drift and a row can tell "the index still says open" from
 * "the index was never written".
 */
export async function seedOpenSessions(homeDir: string, sessionIds: string[]): Promise<void> {
  const dir = sessionsDirOf(homeDir);
  await fs.mkdir(dir, { recursive: true });
  const entries: SessionIndexEntry[] = [];
  for (const sessionId of sessionIds) {
    const record = makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: `${sessionId}-acp`,
      agentCommand: "agent",
      cwd: homeDir,
    });
    const file = recordFileName(sessionId);
    await fs.writeFile(
      path.join(dir, file),
      `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
      "utf8",
    );
    entries.push(toSessionIndexEntry(record, file));
  }
  await writeSessionIndex(dir, { files: entries.map((entry) => entry.file).toSorted(), entries });
}

export async function readIndexEntry(
  homeDir: string,
  sessionId: string,
): Promise<SessionIndexEntry | undefined> {
  const index = await readSessionIndex(sessionsDirOf(homeDir));
  return index?.entries.find((entry) => entry.acpxRecordId === sessionId);
}

export async function readRecordOnDisk(
  homeDir: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(sessionsDirOf(homeDir), recordFileName(sessionId)), "utf8"),
  ) as Record<string, unknown>;
}

export type LiveIndexLock = {
  /** The lock body as written — compare against the file to prove nobody broke it. */
  body: string;
  release: () => Promise<void>;
};

/**
 * Hold `<sessionDir>/index.json.lock` for a LIVE process in this reader's own pid namespace
 * (a sleeper's real birth identity): every waiter judges it live, so it is never taken over —
 * not at 15 s, not ever — and waits out the full 20 s budget. A legacy `{pid,ts}` body would be
 * broken at 15 s and measure nothing. The lock file exists BEFORE this returns, so a process
 * started afterwards can never race the holder ("holder first", CONCEPTION §6).
 */
export async function holdLiveIndexLock(sessionDir: string): Promise<LiveIndexLock> {
  assert.equal(process.platform, "linux", "the live-holder rig needs linux birth identity");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  await once(sleeper, "spawn");
  const identity = readProcessBirthIdentity(sleeper.pid!);
  assert.ok(identity, `identity of the lock holder ${sleeper.pid}`);
  const body = `${JSON.stringify({
    pid: sleeper.pid,
    ts: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: serializeProcessBirthIdentity(identity),
  })}\n`;
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionIndexLockPath(sessionDir), body, { encoding: "utf8", flag: "wx" });
  let released = false;
  return {
    body,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await fs.rm(sessionIndexLockPath(sessionDir), { force: true });
      sleeper.kill("SIGKILL");
    },
  };
}

/** Collects a child's stdout/stderr and lets a row await a stdout line by prefix. */
export class ChildLines {
  stdout = "";
  stderr = "";
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private waiters: Array<{ prefix: string; resolve: (line: string) => void }> = [];

  constructor(readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.stdout += chunk;
      this.settleWaiters();
    });
    child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  private findLine(prefix: string): string | undefined {
    return this.stdout.split("\n").find((line) => line.startsWith(prefix));
  }

  private settleWaiters(): void {
    this.waiters = this.waiters.filter((waiter) => {
      const line = this.findLine(waiter.prefix);
      if (line !== undefined) {
        waiter.resolve(line);
        return false;
      }
      return true;
    });
  }

  async line(prefix: string, timeoutMs: number): Promise<string> {
    const found = this.findLine(prefix);
    if (found !== undefined) {
      return found;
    }
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `child never printed "${prefix}" within ${timeoutMs} ms; stdout=${this.stdout} stderr=${this.stderr}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        prefix,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
      void this.exited.then(() => {
        // a child that exits without the line fails the wait at once, not at the timeout
        if (this.findLine(prefix) === undefined) {
          clearTimeout(timer);
          reject(
            new Error(
              `child exited without printing "${prefix}"; stdout=${this.stdout} stderr=${this.stderr}`,
            ),
          );
        }
      });
    });
  }
}

/** Env for a child acting on `homeDir`'s store: the store is chosen by HOME alone. */
export function childEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  delete env.ACPX_STATE_HOME;
  return env;
}
