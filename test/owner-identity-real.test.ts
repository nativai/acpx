import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  validRecordPidIdentity,
  parseRecordPidIdentity,
} from "../src/process-identity.js";
import { removeTempHome } from "./temp-home.js";

/** The pid of a spawned child — asserted present (lint and the compiler disagree on `!` here). */
function pidOf(child: { pid?: number }): number {
  assert.ok(child.pid, "child has a pid");
  return child.pid;
}

// brick ae547131 — the properties that only a REAL owner (a real `__queue-owner` process with the
// mock ACP agent, driven through the CLI) can show:
//   • `pid_identity` survives real turns (spawn → turn → read the record → turn → close) — the
//     §13.3 first hazard: a field that is present in memory and dropped by some write leg;
//   • the owner's lease carries its scoped identity and host (§4.1);
//   • T34: a SIGTERMed owner releases its own lease and socket (§7.3);
//   • T10: a superseded owner exits and never touches its successor's lease or socket (§7.4);
//   • T11: a vanished lease is re-published with the same generation (§7.2).
// Production interaction shape probed: CLI `sessions new` + `prompt` spawning a detached queue
// owner that spawns the adapter — the same process tree acpx-ui drives.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const linux = process.platform === "linux";

type CliResult = { code: number | null; stdout: string; stderr: string };

function cliEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  for (const name of [
    "ACPX_SESSION_URL",
    "ACPX_SESSION_NAME",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_STATE_HOME",
    "ACPX_BRICK",
    "ACPX_SUBSCRIPTION",
    "ACPX_OWNER_LOG",
  ]) {
    delete env[name];
  }
  return env;
}

async function runCli(args: string[], homeDir: string, cwd: string): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: cliEnv(homeDir),
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`acpx ${args.join(" ")} timed out`));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function agentArgs(cwd: string): string[] {
  return ["--agent", MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
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

type Rig = { homeDir: string; cwd: string; sessionId: string };

async function withRealOwner(run: (rig: Rig) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-owner-real-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-owner-real-cwd-"));
  let sessionId = "";
  try {
    const created = await runCli(
      [...agentArgs(cwd), "--format", "json", "sessions", "new"],
      homeDir,
      cwd,
    );
    assert.equal(created.code, 0, created.stderr);
    const line = created.stdout
      .split("\n")
      .filter((entry) => entry.startsWith("{"))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => typeof entry.acpxRecordId === "string");
    assert.ok(line, created.stdout);
    sessionId = String(line.acpxRecordId);
    const prompted = await runCli(
      [...agentArgs(cwd), "prompt", "echo hello", "--session-id", sessionId],
      homeDir,
      cwd,
    );
    assert.equal(prompted.code, 0, prompted.stderr);
    await run({ homeDir, cwd, sessionId });
  } finally {
    // tear down whatever owner is left — by the lease's pid, which this rig itself created
    const lease = await readLease(homeDir).catch(() => undefined);
    if (lease && alive(lease.pid)) {
      try {
        process.kill(-lease.pid, "SIGKILL");
      } catch {
        process.kill(lease.pid, "SIGKILL");
      }
    }
    await removeTempHome(homeDir);
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

async function leasePath(homeDir: string): Promise<string> {
  const dir = path.join(homeDir, ".acpx", "queues");
  const entries = (await fs.readdir(dir)).filter((name) => name.endsWith(".lock"));
  assert.equal(entries.length, 1, `exactly one lease: ${entries.join(",")}`);
  return path.join(dir, entries[0]);
}

type Lease = {
  pid: number;
  socketPath: string;
  ownerGeneration: number;
  heartbeatAt: string;
  host?: string;
  processIdentity?: Record<string, string>;
};

async function readLease(homeDir: string): Promise<Lease> {
  return JSON.parse(await fs.readFile(await leasePath(homeDir), "utf8")) as Lease;
}

async function readRecord(homeDir: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${sessionId}.json`), "utf8"),
  ) as Record<string, unknown>;
}

test("real owner: pid_identity survives real turns and identifies the live adapter; close kills it by identity", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withRealOwner(async ({ homeDir, cwd, sessionId }) => {
    const lease = await readLease(homeDir);
    // §4.1: the owner's lease carries the fork's legacy kind PLUS its scope, and its host
    assert.equal(lease.processIdentity?.kind, "linux-proc-stat-starttime");
    assert.match(lease.processIdentity?.pidNamespace ?? "", /^pid:\[\d+\]$/);
    assert.equal(lease.host, os.hostname());
    // T22a (§9): the owner's socket is on the shared state volume, recorded in the lease, and the
    // prompt above round-tripped through it
    assert.ok(
      lease.socketPath.startsWith(path.join(homeDir, ".acpx", "q") + path.sep),
      lease.socketPath,
    );
    assert.ok(parseProcessBirthIdentity(lease.processIdentity), "lease identity parses");

    const first = await readRecord(homeDir, sessionId);
    const pid = first.pid as number;
    assert.ok(Number.isInteger(pid), "the record carries the adapter pid after a turn");
    const pidIdentity = parseRecordPidIdentity(first.pid_identity);
    assert.ok(
      pidIdentity,
      `pid_identity missing after a real turn: ${JSON.stringify(first.pid_identity)}`,
    );
    assert.equal(pidIdentity.pid, pid);
    assert.equal(
      observeProcessIncarnation(pid, validRecordPidIdentity(pid, pidIdentity)),
      "matching",
      "pid_identity does not identify the live adapter",
    );

    // a SECOND real turn: the field must survive every write leg of a turn
    const again = await runCli(
      [...agentArgs(cwd), "prompt", "echo again", "--session-id", sessionId],
      homeDir,
      cwd,
    );
    assert.equal(again.code, 0, again.stderr);
    const second = await readRecord(homeDir, sessionId);
    assert.equal(second.pid, pid);
    assert.deepEqual(
      second.pid_identity,
      first.pid_identity,
      "pid_identity lost or changed by a turn",
    );

    const closed = await runCli(
      [...agentArgs(cwd), "--format", "json", "sessions", "close", "--session-id", sessionId],
      homeDir,
      cwd,
    );
    assert.equal(closed.code, 0, closed.stderr);
    const closedLine = closed.stdout
      .split("\n")
      .filter((entry) => entry.startsWith("{"))
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .find((entry) => entry.action === "session_closed");
    assert.ok(closedLine, closed.stdout);
    assert.equal(closedLine.ownerStopped, true);
    await waitFor(async () => (alive(pid) ? undefined : true), 5_000, "the adapter to exit");
    const after = await readRecord(homeDir, sessionId);
    assert.equal(after.pid, undefined);
    assert.equal(after.pid_identity, undefined, "pid_identity not cleared with pid");
  });
});

test("T34 a SIGTERMed owner releases its own lease and socket", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withRealOwner(async ({ homeDir }) => {
    const lockFile = await leasePath(homeDir);
    const lease = await readLease(homeDir);
    await fs.access(lease.socketPath);
    process.kill(lease.pid, "SIGTERM");
    await waitFor(async () => (alive(lease.pid) ? undefined : true), 10_000, "the owner to exit");
    await assert.rejects(fs.access(lockFile), "the SIGTERMed owner left its lease behind");
    await assert.rejects(fs.access(lease.socketPath), "the SIGTERMed owner left its socket behind");
  });
});

test("T34 variant: an owner whose lease was replaced by G2 is SIGTERMed — G2's lease survives", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withRealOwner(async ({ homeDir }) => {
    const lockFile = await leasePath(homeDir);
    const lease = await readLease(homeDir);
    const successor = JSON.stringify({ ...lease, ownerGeneration: lease.ownerGeneration + 7 });
    await fs.writeFile(lockFile, successor);
    process.kill(lease.pid, "SIGTERM");
    await waitFor(async () => (alive(lease.pid) ? undefined : true), 10_000, "the owner to exit");
    assert.equal(await fs.readFile(lockFile, "utf8"), successor, "G2's lease was touched");
    await fs.rm(lockFile, { force: true });
  });
});

test("T10 a superseded owner exits ≤ 10 s and never touches its successor's lease or socket", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withRealOwner(async ({ homeDir, sessionId }) => {
    const lockFile = await leasePath(homeDir);
    const lease = await readLease(homeDir);
    // the "successor": a live sacrificial process in our scope, generation G2, fresh heartbeat
    const sacrificial = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      stdio: "ignore",
    });
    const server = net.createServer((socket) => socket.end());
    try {
      const { readQueueOwnerProcessIdentity } = await import("../src/cli/queue/lease-store.js");
      const g2 = {
        ...lease,
        pid: sacrificial.pid,
        ownerGeneration: lease.ownerGeneration + 1,
        heartbeatAt: new Date().toISOString(),
        processIdentity: await readQueueOwnerProcessIdentity(pidOf(sacrificial)),
      };
      const successorLease = JSON.stringify(g2);
      await fs.writeFile(lockFile, successorLease);
      // the successor unlinks and re-binds the socket path
      await fs.rm(lease.socketPath, { force: true });
      await new Promise<void>((resolve) => server.listen(lease.socketPath, () => resolve()));
      const successorInode = (await fs.stat(lease.socketPath)).ino;

      const deadline = Date.now() + 15_000;
      while (alive(lease.pid) && Date.now() < deadline) {
        assert.equal(await fs.readFile(lockFile, "utf8"), successorLease, "O1 wrote over G2");
        await sleep(200);
      }
      assert.equal(alive(lease.pid), false, "the superseded owner did not exit");
      assert.equal(await fs.readFile(lockFile, "utf8"), successorLease);
      assert.equal((await fs.stat(lease.socketPath)).ino, successorInode, "O1 removed G2's socket");
      const ownerLog = await fs.readFile(
        path.join(homeDir, ".acpx", "sessions", `${sessionId}.owner.log`),
        "utf8",
      );
      assert.match(ownerLog, /superseded by generation/);
      assert.equal(sacrificial.exitCode, null, "the successor's pid was signalled");
    } finally {
      server.close();
      sacrificial.kill("SIGKILL");
      await fs.rm(lockFile, { force: true });
    }
  });
});

test("T11 a deleted lease is re-published by the live owner with the SAME generation", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withRealOwner(async ({ homeDir }) => {
    const lockFile = await leasePath(homeDir);
    const lease = await readLease(homeDir);
    await fs.rm(lockFile);
    const republished = await waitFor(
      async () =>
        await fs
          .readFile(lockFile, "utf8")
          .then((raw) => JSON.parse(raw) as Lease)
          .catch(() => undefined),
      12_000,
      "the lease to be re-published",
    );
    assert.equal(republished.ownerGeneration, lease.ownerGeneration);
    assert.equal(republished.pid, lease.pid);
    assert.equal(alive(lease.pid), true, "still one, live, owner");
  });
});
