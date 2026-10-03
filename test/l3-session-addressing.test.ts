// L3 (brick 8a1d20f0; member bricks 4e58b35c, 6572c1a9) — the same cwd-scoped-name
// resolution produces two independent silent wrong-outcome bugs on `sessions new`
// and `sessions close`. Both rows below are committed from a red branch cut at
// base acpx 991e841 (origin/seat/program) and are byte-identical to the shipped
// version — see verification/evidence under brick 8a1d20f0 for the red run log.
//
// `../src/cli.js` / `./mock-agent.js` resolve against THIS file's own location —
// once compiled to dist-test, that is dist-test/src/cli.js and
// dist-test/test/mock-agent.js, exactly as `pnpm test` builds them.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CliRunOptions = {
  timeoutMs?: number;
  cwd?: string;
};

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-l3-home-"));
  try {
    await run(tempHome);
  } finally {
    // Same ENOTEMPTY race integration.test.ts guards against: `sessions new`
    // leaves a detached queue-owner daemon that can still be writing under
    // <tempHome>/.acpx/sessions/ when this cleanup runs.
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runCli(
  args: string[],
  homeDir: string,
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
      "ACPX_SUBSCRIPTION",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: acpx ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function baseAgentArgs(cwd: string): string[] {
  return ["--agent", MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd];
}

/** Read the record's own BYTES — never the CLI's line — per the brick's acceptance shape. */
async function readSessionRecord(homeDir: string, sessionId: string): Promise<SessionRecord> {
  const recordPath = path.join(
    homeDir,
    ".acpx",
    "sessions",
    `${encodeURIComponent(sessionId)}.json`,
  );
  return JSON.parse(await fs.readFile(recordPath, "utf8")) as SessionRecord;
}

async function createNamedSession(
  homeDir: string,
  cwd: string,
  name: string,
): Promise<{ acpxRecordId: string; raw: Record<string, unknown> }> {
  const result = await runCli(
    [...baseAgentArgs(cwd), "--format", "json", "sessions", "new", "-s", name],
    homeDir,
  );
  assert.equal(result.code, 0, result.stderr);
  const raw = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  const acpxRecordId = raw.acpxRecordId;
  assert.equal(typeof acpxRecordId, "string", result.stdout);
  return { acpxRecordId: acpxRecordId as string, raw };
}

// ---------------------------------------------------------------------------
// brick 4e58b35c — `sessions new` must never evict the occupant of an already-
// occupied (cwd, name) slot. R10/R11: red at base 991e841 (the first session
// read back closed:true after a second `sessions new` into the same slot);
// green on the fix (both stay open, no replacedSessionId in the result shape).
// ---------------------------------------------------------------------------
test("L3/4e58b35c: a second `sessions new` into an occupied (cwd, name) slot leaves the first session OPEN", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-l3-cwd-"));
    try {
      const first = await createNamedSession(homeDir, cwd, "dup-probe");
      const second = await createNamedSession(homeDir, cwd, "dup-probe");

      assert.notEqual(
        second.acpxRecordId,
        first.acpxRecordId,
        "the second create must mint its own record, not reuse the first",
      );

      // The eviction's own signal is gone from the result shape — not merely
      // false, ABSENT, because the deleted behaviour has nothing to report.
      assert.equal(
        Object.prototype.hasOwnProperty.call(second.raw, "replacedSessionId"),
        false,
        `expected no replacedSessionId in: ${JSON.stringify(second.raw)}`,
      );

      // THE row: read the FIRST record's own bytes, never a CLI line or a
      // status word. This is what was `closed:true` at base 991e841.
      const firstRecordAfter = await readSessionRecord(homeDir, first.acpxRecordId);
      assert.equal(
        firstRecordAfter.closed,
        false,
        "the prior occupant of the slot must be left open",
      );

      // Presence pair (R5): the second session is itself a real, independently
      // open record — not merely "first wasn't closed" by some other accident
      // (e.g. the create silently no-op'ing instead of evicting).
      const secondRecordAfter = await readSessionRecord(homeDir, second.acpxRecordId);
      assert.equal(secondRecordAfter.closed, false, "the new session must itself be open");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// brick 6572c1a9 — `sessions close <uuid>` resolves the positional as a
// cwd-scoped NAME, which a uuid never matches. Red at base 991e841: the
// message read as an ordinary not-found with no actionable next step. Green on
// the fix: the message explicitly names --session-id. The exit code was
// ALREADY non-zero at base (verified during implementation, reported upward as
// a correction to the brick's "silent no-op" framing) — this row still asserts
// it, because a row that only re-checks what the fix changed is not proof the
// fix left the rest alone.
// ---------------------------------------------------------------------------
test("L3/6572c1a9: `sessions close <uuid>` positionally refuses non-zero and names --session-id, with a same-record positive control", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-l3-cwd-"));
    try {
      const { acpxRecordId } = await createNamedSession(homeDir, cwd, "close-uuid-probe");

      // THE row: close by the bare uuid, positionally.
      const closedByUuid = await runCli(
        [...baseAgentArgs(cwd), "sessions", "close", acpxRecordId],
        homeDir,
      );
      assert.notEqual(closedByUuid.code, 0, "a positional uuid must not report success");
      assert.match(
        closedByUuid.stderr,
        /--session-id/,
        `expected the refusal to name --session-id, got: ${closedByUuid.stderr}`,
      );

      // Absence assertion: the close that refused did not close anything.
      const recordAfterRefusal = await readSessionRecord(homeDir, acpxRecordId);
      assert.equal(
        recordAfterRefusal.closed,
        false,
        "the refused close must not have closed the record",
      );

      // Presence pair (R5), same record, same arm: --session-id DOES close it.
      // Without this, "closed:false" above is an instrument that answered
      // nothing — it could just as well mean the record can never close at all.
      const closedById = await runCli(
        [
          ...baseAgentArgs(cwd),
          "--format",
          "json",
          "sessions",
          "close",
          "--session-id",
          acpxRecordId,
        ],
        homeDir,
      );
      assert.equal(closedById.code, 0, closedById.stderr);
      const recordAfterRealClose = await readSessionRecord(homeDir, acpxRecordId);
      assert.equal(
        recordAfterRealClose.closed,
        true,
        "--session-id must actually close the record",
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Positive control for the ROW ABOVE, not the uncontested half (hazard #7):
// closing by an actual positional NAME that DOES resolve must keep working
// unchanged — otherwise the refusal above could be "every positional close now
// fails", which would pass the row above for the wrong reason entirely.
// ---------------------------------------------------------------------------
