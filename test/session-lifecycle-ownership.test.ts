// Tests for session-lifecycle-state ownership (see DESIGN.md).
//
// Principles under test:
//   1. `writeSessionRecord` preserves on-disk `closed` / `closed_at` — a UI
//      PATCH that flipped `closed=true` survives a subsequent daemon write.
//   2. `writeSessionRecordWithLifecycle` is the privileged variant used by
//      `closeSession`; it bypasses preservation so the daemon can write
//      `closed: true`.
//   3. `runSessionPrompt` (via `runQueuedTask`) rejects a closed session with
//      `SessionClosedError` at turn entry — no silent reopen.
//   4. A queued prompt for a session that was closed between queueing and
//      pickup rejects cleanly with SessionClosedError.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { SessionClosedError } from "../src/errors.js";
import { textPrompt } from "../src/prompt-content.js";
import {
  writeSessionRecord as repoWriteSessionRecord,
  writeSessionRecordWithLifecycle,
  resolveSessionRecord,
} from "../src/session/persistence/repository.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import type { SessionRecord } from "../src/types.js";

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-lifecycle-home-"));
  process.env.HOME = tempHome;

  try {
    await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(acpxRecordId)}.json`);
}

async function seedSessionJson(homeDir: string, record: SessionRecord): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): SessionRecord {
  const timestamp = "2026-04-20T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    cwd: path.resolve(overrides.cwd),
    name: overrides.name,
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: overrides.lastSeq ?? 0,
    lastRequestId: overrides.lastRequestId,
    eventLog: overrides.eventLog ?? {
      active_path: `.stream.ndjson`,
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    pid: overrides.pid,
    agentStartedAt: overrides.agentStartedAt,
    lastPromptAt: overrides.lastPromptAt,
    lastAgentExitCode: overrides.lastAgentExitCode,
    lastAgentExitSignal: overrides.lastAgentExitSignal,
    lastAgentExitAt: overrides.lastAgentExitAt,
    lastAgentDisconnectReason: overrides.lastAgentDisconnectReason,
    protocolVersion: overrides.protocolVersion,
    agentCapabilities: overrides.agentCapabilities,
    title: overrides.title ?? null,
    messages: overrides.messages ?? [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: overrides.cumulative_token_usage ?? {},
    request_token_usage: overrides.request_token_usage ?? {},
    acpx: overrides.acpx,
  };
}

test("writeSessionRecord preserves on-disk closed=true when in-memory record says false", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "repo");

    // 1. Seed disk with closed=true (UI PATCH result).
    const closedOnDisk = makeSessionRecord({
      acpxRecordId: "preserve-closed",
      acpSessionId: "preserve-closed",
      agentCommand: "agent-a",
      cwd,
      closed: true,
      closedAt: "2026-04-20T10:00:00.000Z",
    });
    await seedSessionJson(homeDir, closedOnDisk);

    // 2. Daemon builds an in-memory record with closed=false (stale view)
    //    and calls the plain `writeSessionRecord`.
    const stale = makeSessionRecord({
      acpxRecordId: "preserve-closed",
      acpSessionId: "preserve-closed",
      agentCommand: "agent-a",
      cwd,
      closed: false,
      closedAt: undefined,
      lastUsedAt: "2026-04-20T12:00:00.000Z",
      updated_at: "2026-04-20T12:00:00.000Z",
    });
    await repoWriteSessionRecord(stale);

    // 3. Disk must still carry closed=true and the original closedAt.
    const afterPath = sessionFilePath(homeDir, "preserve-closed");
    const afterJson = JSON.parse(await fs.readFile(afterPath, "utf8")) as Record<string, unknown>;
    assert.equal(afterJson.closed, true, "closed must remain true after plain write");
    assert.equal(
      afterJson.closed_at,
      "2026-04-20T10:00:00.000Z",
      "closed_at must remain the original UI-written value",
    );

    // 4. But non-lifecycle fields must still reflect the daemon's new values.
    assert.equal(
      afterJson.last_used_at,
      "2026-04-20T12:00:00.000Z",
      "daemon-owned fields must still be written through",
    );

    // 5. And the in-memory record returned by resolve must show the disk's truth.
    const resolved = await resolveSessionRecord("preserve-closed");
    assert.equal(resolved.closed, true);
    assert.equal(resolved.closedAt, "2026-04-20T10:00:00.000Z");
  });
});

test("writeSessionRecordWithLifecycle bypasses preservation (privileged close path)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "repo");

    // 1. Seed disk with closed=false.
    const openOnDisk = makeSessionRecord({
      acpxRecordId: "privileged-close",
      acpSessionId: "privileged-close",
      agentCommand: "agent-a",
      cwd,
      closed: false,
    });
    await seedSessionJson(homeDir, openOnDisk);

    // 2. Daemon closeSession flow writes closed=true via privileged helper.
    const closing = makeSessionRecord({
      acpxRecordId: "privileged-close",
      acpSessionId: "privileged-close",
      agentCommand: "agent-a",
      cwd,
      closed: true,
      closedAt: "2026-04-20T13:00:00.000Z",
    });
    await writeSessionRecordWithLifecycle(closing);

    // 3. Disk must now reflect closed=true.
    const afterPath = sessionFilePath(homeDir, "privileged-close");
    const afterJson = JSON.parse(await fs.readFile(afterPath, "utf8")) as Record<string, unknown>;
    assert.equal(afterJson.closed, true);
    assert.equal(afterJson.closed_at, "2026-04-20T13:00:00.000Z");
  });
});

test("writeSessionRecord leaves closed field absent when no prior on-disk record exists", async () => {
  await withTempHome(async (homeDir) => {
    // Create-session flow: no file on disk yet. writeSessionRecord must NOT
    // silently clobber the caller's `closed: false` to something else — it
    // should simply write the caller's value (preserve step no-ops when
    // there is nothing to preserve).
    const cwd = path.join(homeDir, "repo");
    const fresh = makeSessionRecord({
      acpxRecordId: "fresh-record",
      acpSessionId: "fresh-record",
      agentCommand: "agent-a",
      cwd,
      closed: false,
    });
    await repoWriteSessionRecord(fresh);

    const afterJson = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "fresh-record"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(afterJson.closed, false);
  });
});

// ----- SessionClosedError path -----

function makeQueueTask(requestId: string, onSend: (message: QueueOwnerMessage) => void): QueueTask {
  return {
    requestId,
    message: "do a thing",
    prompt: textPrompt("do a thing"),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send(message: QueueOwnerMessage) {
      onSend(message);
    },
    close() {
      /* no-op for tests */
    },
  } satisfies QueueTask;
}

test("runQueuedTask rejects a closed session with SESSION_CLOSED (queued-prompt fail-loud)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "repo");
    await seedSessionJson(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "queued-closed",
        acpSessionId: "queued-closed",
        agentCommand: "node",
        cwd,
        closed: true,
        closedAt: "2026-04-20T14:00:00.000Z",
      }),
    );

    const responses: QueueOwnerMessage[] = [];
    const task = makeQueueTask("req-queued-closed", (response) => {
      responses.push(response);
    });

    await runQueuedTask("queued-closed", task, {});

    const errorResponse = responses.find((entry) => entry.type === "error");
    assert.ok(errorResponse, "queued task must produce an error response");
    if (errorResponse?.type !== "error") {
      return;
    }
    assert.equal(errorResponse.detailCode, "SESSION_CLOSED");
    assert.equal(errorResponse.code, "RUNTIME");
    assert.match(errorResponse.message, /closed/i);
    assert.match(errorResponse.message, /reopen/i);
  });
});

test("SessionClosedError formats the session name when available", () => {
  const withName = new SessionClosedError("some-id", "my-session");
  assert.match(withName.message, /'my-session'/);
  assert.match(withName.message, /Reopen/);
  assert.equal(withName.detailCode, "SESSION_CLOSED");
  assert.equal(withName.outputCode, "RUNTIME");

  const withoutName = new SessionClosedError("raw-id", undefined);
  assert.match(withoutName.message, /'raw-id'/);
});
