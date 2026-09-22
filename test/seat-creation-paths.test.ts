import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { SessionNotification, SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick 5ad22d5d, GATE-B1-FALSIFIABILITY §G2 — "Any path yields a record read
// back from disk with seat_id absent/empty" is the falsifying observation, and
// THREE SEPARATE tests are required: a shared test exercising one path is
// exactly the failure mode D-B1-7 warns about — path 3 (runtime.ts
// teammate_spawned) is the one a createSessionRecordWithClient-level fix
// misses silently, because it is the only path not reached through it.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const MOCK_AGENT_WITH_FORK_SESSION = `${MOCK_AGENT_COMMAND} --supports-fork-session`;

type CliResult = { code: number | null; stdout: string; stderr: string };

// Modelled directly on session-reparent.test.ts's runCli — same scrub list
// (a fixture built without it can silently acquire the TEST RUNNER's own
// session as ambient context) plus the same real-compiled-CLI rationale: the
// failure this feature is exposed to is a field dropped by one of the
// field-by-field persistence transforms, and every one of those legs is
// green under a unit call on the mutator alone.
function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
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
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-creation-paths-", run);
}

async function readRecordJson(homeDir: string, id: string): Promise<Record<string, unknown>> {
  const file = path.join(homeDir, ".acpx", "sessions", `${id}.json`);
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

// ─── Path 1 — normal create ─────────────────────────────────────────────────

test("G2/path 1 · `sessions new` mints a fresh seat, read back from DISK", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

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
        "path1",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // Read back from DISK, not the CLI's own stdout echo — the falsifying
    // observation is specifically about what a REAL FILE READ finds.
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(
      typeof onDisk.seat_id === "string" && (onDisk.seat_id as string).length > 0,
      true,
      "path 1: seat_id absent/empty on the record read back from disk",
    );
    assert.equal(onDisk.holder_ordinal, 1);
    assert.equal(onDisk.holder_active, true);
  });
});

// ─── Path 2 — fork / copy ───────────────────────────────────────────────────

test("G2/path 2 · `sessions copy` mints a NEW seat, never inherits the source's, read back from DISK", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_WITH_FORK_SESSION,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "path2-source",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const sourceId = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const sourceOnDisk = await readRecordJson(homeDir, sourceId);
    const sourceSeatId = sourceOnDisk.seat_id;
    assert.equal(typeof sourceSeatId, "string");

    const copied = await runCli(
      ["--format", "json", "sessions", "copy", "--from", sourceId, "--name", "path2-fork"],
      homeDir,
    );
    assert.equal(copied.code, 0, copied.stderr);
    const forkedId = String(
      (JSON.parse(copied.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const forkedOnDisk = await readRecordJson(homeDir, forkedId);
    assert.equal(
      typeof forkedOnDisk.seat_id === "string" && (forkedOnDisk.seat_id as string).length > 0,
      true,
      "path 2: seat_id absent/empty on the record read back from disk",
    );
    assert.notEqual(
      forkedOnDisk.seat_id,
      sourceSeatId,
      "a fork must NEVER inherit the source's seat (Daniel, 2026-09-22: every fork mints a new seat)",
    );
    assert.equal(forkedOnDisk.holder_ordinal, 1);
    assert.equal(forkedOnDisk.holder_active, true);
  });
});

// ─── Path 3 — subagent shadow record (teammate_spawned) ────────────────────
//
// This path is genuinely NOT reachable through the CLI-subprocess pattern
// above: it fires from an in-flight `session/update` frame during a live
// prompt turn, which mock-agent.ts has no scripted trigger for (its
// tool_call/tool_call_update simulation is a generic "LateTool", not a
// teammate_spawned shape). Exercised instead at the level D-B1-7 names as the
// hazard: runQueuedTask -> runSessionPrompt's REAL onSessionUpdate handler,
// via a minimal AcpClient mock that captures and fires it — the same
// AcpClient-mocking convention test/mid-turn-injection.test.ts already uses
// for this exact production handler chain, extended to capture
// onSessionUpdate (which that file's mock deliberately no-ops).

function teammateSpawnedNotification(sessionId: string, subagentId: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      _meta: {
        claudeCode: {
          status: "teammate_spawned",
          subagentId,
          subagentName: "worker-agent",
        },
      },
    },
  } as unknown as SessionNotification;
}

function makeSubagentSpawningClient(sessionId: string, subagentId: string): AcpClient {
  let capturedOnSessionUpdate: ((notification: SessionNotification) => void) | undefined;
  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: (handlers: { onSessionUpdate?: (n: SessionNotification) => void }) => {
      capturedOnSessionUpdate = handlers.onSessionUpdate;
    },
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: async () => {
      // Fire the teammate_spawned frame mid-turn, exactly as a real adapter
      // would via session/update, before the turn resolves.
      capturedOnSessionUpdate?.(teammateSpawnedNotification(sessionId, subagentId));
      return { stopReason: "end_turn" as const };
    },
  };
  return mock as unknown as AcpClient;
}

test("G2/path 3 · a teammate_spawned notification mints a shadow-record seat, read back from DISK", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const parentRecord: SessionRecord = makeSessionRecordFixture({
      acpxRecordId: "parent-session",
      acpSessionId: "parent-session-acp",
      agentCommand: "node mock-agent.js",
      cwd,
      seatId: "parent-seat",
      holderOrdinal: 1,
      holderActive: true,
    });
    await writeSessionRecordFile(homeDir, parentRecord);

    const client = makeSubagentSpawningClient("parent-session-acp", "subagent-1");
    const task: QueueTask = {
      requestId: "req-1",
      message: "spawn a subagent",
      prompt: textPrompt("spawn a subagent"),
      permissionMode: "approve-all",
      timeoutMs: 10_000,
      waitForCompletion: true,
      enqueuedAt: Date.now(),
      send: () => {},
      close: () => {},
    };

    await runQueuedTask("parent-session", task, {
      sharedClient: client,
      suppressSdkConsoleErrors: true,
    });

    // The child's id is minted internally (crypto.randomUUID()) — find it by
    // reading the PARENT record's subagents[] back off disk, then read the
    // child record independently. Both reads are real disk reads, matching
    // G2's falsifying observation.
    const reloadedParent = await resolveSessionRecord("parent-session");
    const childRef = reloadedParent.subagents?.[0];
    assert.ok(childRef, "parent record must list the spawned subagent");

    const childRecord = await resolveSessionRecord(childRef.acpxRecordId);
    assert.equal(childRecord.kind, "subagent");
    assert.equal(childRecord.parentSessionId, "parent-session");
    assert.ok(
      childRecord.seatId,
      "path 3 (subagent shadow record): seat_id absent on the record read back from disk — " +
        "this is the path a createSessionRecordWithClient-level fix misses silently",
    );
    assert.notEqual(
      childRecord.seatId,
      "parent-seat",
      "a subagent shadow record gets its OWN seat, not its parent's (no carve-outs, DECISIONS-HOD §D1)",
    );
    assert.equal(childRecord.holderOrdinal, 1);
    assert.equal(childRecord.holderActive, true);
    assert.equal(
      childRecord.parentSeatId,
      "parent-seat",
      "the shadow record's parentSeatId must name its parent's actual seat",
    );
  });
});
