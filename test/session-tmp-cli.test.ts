import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_TMP_ROOT_ENV } from "../src/acp/session-tmp-dir.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * brick ceca191f (SPEC.md acceptance criterion 7) — the CLI wiring, end to end:
 * `sessions sweep-config-dirs` piggybacks the ACPX_SESSION_TMP reaper onto the
 * same trigger as the harness-config-dir sweep (see
 * `sweepOrphanSessionTmpDirsPhase` in `command-handlers.ts`). The pure
 * classification rule itself is covered by `session-tmp-sweep.test.ts`; this
 * file proves the CLI actually reaches it against a REAL session store and a
 * REAL `/proc` census.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string, sessionTmpRoot: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
      [SESSION_TMP_ROOT_ENV]: sessionTmpRoot,
    };
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withScopedSessionTmpRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "acpx-session-tmp-cli-test-"));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function seedSession(
  homeDir: string,
  id: string,
  overrides: { closed?: boolean; lastUsedAt?: string },
): Promise<void> {
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord(
      {
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
        agentName: "claude",
        cwd: homeDir,
        createdAt: overrides.lastUsedAt ?? "2026-01-01T00:00:00.000Z",
        lastUsedAt: overrides.lastUsedAt ?? "2026-01-01T00:00:00.000Z",
        closed: overrides.closed,
      },
      { defaultName: false, defaultAcpx: false },
    ),
  );
}

function plantSessionTmpDir(root: string, sessionId: string): string {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "scratch.txt"), "leftover\n");
  return dir;
}

const CLOSED_LONG_AGO = "44444444-4444-4444-4444-444444444444";
const STILL_OPEN = "55555555-5555-5555-5555-555555555555";

test("`sessions sweep-config-dirs` reaps a CLOSED session's ACPX_SESSION_TMP dir past the grace period", async () => {
  await withTempHomeFixture("acpx-ceca191f-tmp-sweep-", async (homeDir) => {
    await withScopedSessionTmpRoot(async (root) => {
      // 2026-01-01 is ~9 months before "today" in this environment — far past
      // both the 7-day grace period and the 30-day hard ceiling, so this row
      // does not depend on wall-clock proximity to be meaningful.
      await seedSession(homeDir, CLOSED_LONG_AGO, { closed: true });
      const dir = plantSessionTmpDir(root, CLOSED_LONG_AGO);

      const result = await runCli(["claude", "sessions", "sweep-config-dirs"], homeDir, root);

      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(
        result.stderr,
        /\[acpx\] session tmp sweep \(.*\): scanned=1 removed=1/,
        `session-tmp census missing or wrong:\n${result.stderr}`,
      );
      assert.equal(existsSync(dir), false, "the closed session's scratch dir must be reaped");
    });
  });
});

test("`sessions sweep-config-dirs` leaves an OPEN session's ACPX_SESSION_TMP dir untouched", async () => {
  await withTempHomeFixture("acpx-ceca191f-tmp-sweep-open-", async (homeDir) => {
    await withScopedSessionTmpRoot(async (root) => {
      // ⚠️ Deliberately RECENT, unlike the closed-session row above. `sessions
      // sweep-config-dirs` also runs the ABANDONED-RECORD sweep first (24h idle,
      // no live owner ⇒ closed) — an "open" record dated 2026-01-01 would be
      // closed by THAT sweep before the session-tmp pass ever sees it, which
      // would make this row pass for the wrong reason (or fail outright). A
      // record used moments ago is neither abandoned nor closed, so the ONLY
      // thing under test here is the session-tmp sweep's own openRecord clause.
      await seedSession(homeDir, STILL_OPEN, {
        closed: false,
        lastUsedAt: new Date().toISOString(),
      });
      const dir = plantSessionTmpDir(root, STILL_OPEN);

      const result = await runCli(["claude", "sessions", "sweep-config-dirs"], homeDir, root);

      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(dir), true, "an OPEN session's scratch dir must never be reaped");
      assert.match(result.stderr, /openRecord=1/, result.stderr);
    });
  });
});

const CLOSED_BUT_LIVE = "66666666-6666-6666-6666-666666666666";

test("`sessions sweep-config-dirs` retains a CLOSED-and-ancient session's dir while a REAL process is still live, then reaps it once that process is gone", async () => {
  // ⚠️ THE POINT OF THIS ROW: a record alone cannot prove the live-process clause
  // works — a test that only injects `{closed:true, idleMs: huge}` and checks
  // retention could pass even if the liveness check were deleted from the code,
  // AS LONG AS something else also happened to retain it. This spawns an ACTUAL
  // process (not a simulated LiveProcessScan) whose cmdline carries the session's
  // uuid, and lets the CLI's REAL `scanLiveProcesses()` (real /proc, box-wide, no
  // injected fixture) find it — then proves the DIFFERENTIAL: same closed+ancient
  // record, sweep run twice, retained while live and reaped once it is not.
  await withTempHomeFixture("acpx-ceca191f-tmp-sweep-live-", async (homeDir) => {
    await withScopedSessionTmpRoot(async (root) => {
      await seedSession(homeDir, CLOSED_BUT_LIVE, { closed: true }); // ancient + closed
      const dir = plantSessionTmpDir(root, CLOSED_BUT_LIVE);

      // A real, live process whose argv carries the session id — exactly the
      // shape `readSessionIdsFromCmdline` (process-population.ts) scans for.
      const liveHolder = spawn(
        process.execPath,
        ["-e", "setTimeout(()=>{},60000)", CLOSED_BUT_LIVE],
        {
          stdio: "ignore",
        },
      );
      try {
        // Give /proc a moment to reflect the new process before the CLI scans it.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const whileLive = await runCli(["claude", "sessions", "sweep-config-dirs"], homeDir, root);
        assert.equal(whileLive.code, 0, `${whileLive.stdout}\n${whileLive.stderr}`);
        assert.equal(
          existsSync(dir),
          true,
          "a REAL live process naming this session must block the reap, even though the " +
            "record is closed and ancient",
        );
        assert.match(whileLive.stderr, /liveProcess=1/, whileLive.stderr);
      } finally {
        liveHolder.kill("SIGKILL");
        await new Promise((resolve) => {
          liveHolder.once("exit", resolve);
        });
      }

      // Same record, same directory, same sweep invocation — the ONLY thing that
      // changed is that the live process is now gone. This is the differential
      // that proves retention above was caused by liveness, not by luck.
      const afterExit = await runCli(["claude", "sessions", "sweep-config-dirs"], homeDir, root);
      assert.equal(afterExit.code, 0, `${afterExit.stdout}\n${afterExit.stderr}`);
      assert.equal(
        existsSync(dir),
        false,
        "once the live process is gone, the same closed+ancient session must be reaped",
      );
    });
  });
});

test("`sessions sweep-config-dirs --dry-run` previews the session-tmp reap and removes nothing", async () => {
  await withTempHomeFixture("acpx-ceca191f-tmp-sweep-dry-", async (homeDir) => {
    await withScopedSessionTmpRoot(async (root) => {
      await seedSession(homeDir, CLOSED_LONG_AGO, { closed: true });
      const dir = plantSessionTmpDir(root, CLOSED_LONG_AGO);

      const result = await runCli(
        ["claude", "sessions", "sweep-config-dirs", "--dry-run"],
        homeDir,
        root,
      );

      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(dir), true, "a dry run must not delete anything");
      assert.match(result.stderr, /session tmp sweep/, result.stderr);
    });
  });
});
