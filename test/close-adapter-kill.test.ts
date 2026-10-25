import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath, queueSharedSocketDir } from "../src/cli/queue/paths.js";
import {
  captureRecordPidIdentity,
  readProcessBirthIdentity,
  type RecordPidIdentity,
} from "../src/process-identity.js";
import { startKeeperProcess, stopProcess, writeQueueOwnerLock } from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";
import { removeTempHome } from "./temp-home.js";

// brick ae547131 §12.1 C — T32a–f through the REAL CLI (`acpx sessions close|recover`), and the
// cross-repo JSON contract acpx-ui consumes (CONCEPT §8.2, §8.4; HoD pin 2026-10-13):
//   close   → TOP-LEVEL `ownerStopped` (boolean) + `ownerStopSkipped` on the `session_closed` line
//   recover → `killSkipped` (boolean) + `skipReason`, and exit 1 when a live owner was not stopped
//
// ⊗ T32a: on d9ab5c0d `isLikelyMatchingProcess` matches the `node` argv entry of the sacrificial
// process and KILLS it. Fixtures use a production-shaped agent_command (every real claude record is
// a node + adapter-path command), never the synthetic strings no real record carries.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PRODUCTION_AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const linux = process.platform === "linux";

type CliResult = { code: number | null; stdout: string; stderr: string };

async function runCli(args: string[], homeDir: string): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  for (const name of [
    "ACPX_SESSION_URL",
    "ACPX_SESSION_NAME",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_STATE_HOME",
    "ACPX_BRICK",
    "ACPX_SUBSCRIPTION",
  ]) {
    delete env[name];
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: homeDir,
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

/** The `session_closed` line (by action), or the recover RESULT line (the one carrying `ownerFound`
 *  — a recover that exits 1 prints its result first and then a JSON-RPC error line). */
function jsonLine(stdout: string, action?: string): Record<string, unknown> {
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const found = action
    ? lines.find((line) => line.action === action)
    : lines.find((line) => "ownerFound" in line);
  assert.ok(found, `no JSON line${action ? ` with action ${action}` : ""} in: ${stdout}`);
  return found;
}

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-close-kill-"));
  try {
    await run(homeDir);
  } finally {
    await removeTempHome(homeDir);
  }
}

async function writeRecord(
  homeDir: string,
  sessionId: string,
  pid: number,
  pidIdentity?: RecordPidIdentity,
): Promise<void> {
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: PRODUCTION_AGENT_COMMAND,
      cwd: homeDir,
      pid,
      ...(pidIdentity ? { pidIdentity } : {}),
    }),
  );
}

type Variant = {
  id: string;
  identity: (pid: number) => RecordPidIdentity | undefined;
  closeKills: boolean;
  reason?: string;
};

const VARIANTS: Variant[] = [
  { id: "T32a", identity: () => undefined, closeKills: false, reason: "no-identity" },
  {
    id: "T32b",
    identity: (pid) => {
      const captured = captureRecordPidIdentity(pid)!;
      return { ...captured, start_ticks: String(Number(captured.start_ticks) + 1) };
    },
    closeKills: false,
    reason: "gone",
  },
  {
    id: "T32c",
    identity: (pid) => ({ ...captureRecordPidIdentity(pid)!, pid_namespace: "pid:[1]" }),
    closeKills: false,
    reason: "foreign",
  },
  {
    id: "T32d",
    identity: (pid) => ({ ...captureRecordPidIdentity(pid)!, pid: pid + 1 }),
    closeKills: false,
    reason: "no-identity",
  },
  { id: "T32e", identity: (pid) => captureRecordPidIdentity(pid), closeKills: true },
];

for (const variant of VARIANTS) {
  test(`${variant.id} sessions close: the adapter at record.pid is signalled ${variant.closeKills ? "(identity matches)" : `ONLY with a matching identity — reason ${variant.reason}`}`, async (t) => {
    if (!linux) {
      t.skip("linux identity");
      return;
    }
    await withHome(async (homeDir) => {
      const sacrificial = await startKeeperProcess();
      const pid = sacrificial.pid!;
      const sessionId = `${variant.id.toLowerCase()}-close`;
      try {
        const startBefore = readProcessBirthIdentity(pid);
        await writeRecord(homeDir, sessionId, pid, variant.identity(pid));
        const closed = await runCli(
          ["--format", "json", "sessions", "close", "--session-id", sessionId],
          homeDir,
        );
        assert.equal(closed.code, 0, closed.stderr);
        const line = jsonLine(closed.stdout, "session_closed");
        assert.equal(line.recordClosed, true);
        assert.equal(line.ownerStopped, true, "no lease: there was no owner to stop");
        if (variant.closeKills) {
          assert.deepEqual(line.adapterKill, { signalled: true });
          if (sacrificial.exitCode === null && sacrificial.signalCode === null) {
            await new Promise((resolve) => sacrificial.once("exit", resolve));
          }
          assert.equal(sacrificial.signalCode, "SIGTERM", "S was not terminated by the close");
        } else {
          assert.deepEqual(line.adapterKill, { signalled: false, reason: variant.reason });
          assert.deepEqual(readProcessBirthIdentity(pid), startBefore, "S was signalled");
          assert.equal(sacrificial.exitCode, null);
        }
      } finally {
        stopProcess(sacrificial);
      }
    });
  });

  test(`${variant.id} via sessions recover (T32f): recover never touches record.pid`, async (t) => {
    if (!linux) {
      t.skip("linux identity");
      return;
    }
    await withHome(async (homeDir) => {
      const sacrificial = await startKeeperProcess();
      const pid = sacrificial.pid!;
      const sessionId = `${variant.id.toLowerCase()}-recover`;
      try {
        await writeRecord(homeDir, sessionId, pid, variant.identity(pid));
        const recovered = await runCli(
          ["--format", "json", "sessions", "recover", sessionId],
          homeDir,
        );
        assert.equal(recovered.code, 0, recovered.stderr);
        assert.equal(jsonLine(recovered.stdout).ownerFound, false);
        assert.equal(sacrificial.exitCode, null, "recover signalled record.pid");
      } finally {
        stopProcess(sacrificial);
      }
    });
  });
}

/**
 * THE CONTRACT (acpx-ui consumes exactly these JSON paths). A foreign owner — another pid namespace,
 * fresh heartbeat — is neither stopped by close nor recovered; both say so, and recover exits 1.
 */
test("contract: close → top-level ownerStopped:false + ownerStopSkipped; recover → killSkipped + skipReason + exit 1", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withHome(async (homeDir) => {
    const sacrificial = await startKeeperProcess();
    const pid = sacrificial.pid!;
    try {
      for (const verb of ["recover", "close"] as const) {
        const sessionId = `contract-${verb}`;
        await writeRecord(homeDir, sessionId, pid);
        const identity = await readQueueOwnerProcessIdentity(pid);
        assert.ok(identity);
        await writeQueueOwnerLock({
          lockPath: queueLockFilePath(sessionId, homeDir),
          pid,
          sessionId,
          socketPath: path.join(queueSharedSocketDir(homeDir), `${sessionId}.sock`),
          processIdentity: { ...identity, pidNamespace: "pid:[1]" },
          host: "dev-server-workbench-x",
        });
        const target = verb === "close" ? ["--session-id", sessionId] : [sessionId];
        const result = await runCli(["--format", "json", "sessions", verb, ...target], homeDir);
        if (verb === "recover") {
          assert.equal(result.code, 1, "recover of a live foreign owner must exit non-zero");
          const line = jsonLine(result.stdout);
          assert.equal(line.killSkipped, true);
          assert.equal(line.skipReason, "foreign-owner");
          assert.equal(line.ownerScope, "foreign");
          assert.equal(line.ownerHost, "dev-server-workbench-x");
          // --format json: the error is a JSON-RPC line on stdout (text mode prints it on stderr)
          assert.match(result.stdout + result.stderr, /not signalled/);
        } else {
          assert.equal(result.code, 0, `the close landed: ${result.stderr}`);
          const line = jsonLine(result.stdout, "session_closed");
          assert.equal(line.ownerStopped, false);
          assert.equal(line.ownerStopSkipped, "foreign-owner");
          assert.equal(line.recordClosed, true);
        }
        assert.equal(sacrificial.exitCode, null, `${verb} signalled a foreign owner's pid`);
        await fs.access(queueLockFilePath(sessionId, homeDir));
      }
    } finally {
      stopProcess(sacrificial);
    }
  });
});
