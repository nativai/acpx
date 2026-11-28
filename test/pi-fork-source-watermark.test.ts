// P1 (brick e9f71106, ruling row (c); the sub-HoD's GO with two conditions): the Pi transcript's length floor.
//
// The source's owner records the length of the pi JSONL at the end of each completed turn
// (`acpx.pi_transcript_bytes`, `stampPiTranscriptWatermark`); a fork refuses `PI_FORK_SOURCE_SHORT_READ` when
// the file its own pod sees is shorter (`assertPiForkSourceComplete`).
//   Condition 1: the field survives `cloneSessionAcpxState` — proven through a REAL TURN below, which goes red
//                if the clone line is removed (the persisted write is based on that clone).
//   Condition 2: a record with no floor forks exactly as today — the rows here and the CLI rows in
//                `sessions-copy-at-log-index.test.ts`.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPiForkSourceComplete,
  stampPiTranscriptWatermark,
} from "../src/acp/harness-config-dir.js";
import {
  releaseQueueOwnerLease,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import {
  PI_FORK_SOURCE_SHORT_READ_DETAIL_CODE,
  PiForkSourceShortReadError,
} from "../src/errors.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { connectSocket, nextJsonLine } from "./queue-test-helpers.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

function slug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Plant `<box>/sessions/<slug(cwd)>/<stamp>_<acpSessionId>.jsonl` of `bytes` bytes; returns its path. */
function plantPiTranscript(box: string, cwd: string, acpSessionId: string, bytes: number): string {
  const dir = path.join(box, "sessions", slug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-11-28T00-00-00_${acpSessionId}.jsonl`);
  writeFileSync(file, "x".repeat(bytes));
  return file;
}

function piSource(over: { cwd: string; floor?: number }) {
  return {
    acpxRecordId: "p1c-source",
    agentCommand: "node /opt/pi-acp/dist/index.js",
    cwd: over.cwd,
    acpSessionId: "acp-p1c-source",
    acpx: over.floor === undefined ? {} : { pi_transcript_bytes: over.floor },
  };
}

test("P1 (c) clone leg: cloneSessionAcpxState carries pi_transcript_bytes", () => {
  assert.equal(cloneSessionAcpxState({ pi_transcript_bytes: 1234 })?.pi_transcript_bytes, 1234);
});

test("P1 (c) check: shorter than the floor, or missing, is refused by name; equal or longer passes", async () => {
  await withTempHome("acpx-p1c-wm-unit-", async (home) => {
    const box = path.join(home, "box-agent");
    const cwd = path.join(home, "work");
    const env = { ACPX_PI_BOX_AGENT_DIR: box };
    const isShort = (error: unknown) => {
      assert.ok(error instanceof PiForkSourceShortReadError, String(error));
      assert.equal(error.detailCode, PI_FORK_SOURCE_SHORT_READ_DETAIL_CODE);
      assert.match(error.message, /^PI_FORK_SOURCE_SHORT_READ: /);
      return true;
    };
    assert.throws(() => assertPiForkSourceComplete(piSource({ cwd, floor: 100 }), env), isShort);
    plantPiTranscript(box, cwd, "acp-p1c-source", 99);
    assert.throws(() => assertPiForkSourceComplete(piSource({ cwd, floor: 100 }), env), isShort);
    plantPiTranscript(box, cwd, "acp-p1c-source", 100);
    assertPiForkSourceComplete(piSource({ cwd, floor: 100 }), env);
    plantPiTranscript(box, cwd, "acp-p1c-source", 150);
    assertPiForkSourceComplete(piSource({ cwd, floor: 100 }), env);
  });
});

test("P1 (c) check: NO floor (a record from before this acpx) is never refused, even with no transcript at all", async () => {
  await withTempHome("acpx-p1c-wm-nofloor-", async (home) => {
    const env = { ACPX_PI_BOX_AGENT_DIR: path.join(home, "box-agent") };
    assertPiForkSourceComplete(piSource({ cwd: path.join(home, "work") }), env);
    // And a non-pi source with a stray floor is not this check's business.
    assertPiForkSourceComplete(
      {
        ...piSource({ cwd: path.join(home, "work"), floor: 100 }),
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      },
      env,
    );
  });
});

test("P1 (c) writer: a found transcript stamps its size; none found stamps nothing", async () => {
  await withTempHome("acpx-p1c-wm-stamp-", async (home) => {
    const box = path.join(home, "box-agent");
    const cwd = path.join(home, "work");
    const env = { ACPX_PI_BOX_AGENT_DIR: box };
    const record = makeSessionRecord({
      acpxRecordId: "p1c-stamp",
      acpSessionId: "acp-p1c-stamp",
      agentCommand: "node /opt/pi-acp/dist/index.js",
      cwd,
    });
    stampPiTranscriptWatermark(record, env);
    assert.equal(record.acpx?.pi_transcript_bytes, undefined, "nothing found, nothing stamped");
    plantPiTranscript(box, cwd, "acp-p1c-stamp", 321);
    stampPiTranscriptWatermark(record, env);
    assert.equal(record.acpx?.pi_transcript_bytes, 321);
  });
});

// ─── THE REAL TURN: a real SessionQueueOwner, an accepted no-wait task, a real AcpClient spawning a pi-CLASSIFIED
// mock (the mock binary under a `pi-acp/` path), the turn's own persisted write. The record ON DISK must carry the
// floor: `savePromptSuccess` stamps it and then re-bases the persisted state off `cloneSessionAcpxState`, so this
// row goes red if the clone drops the field.

const MESSAGE_ID = "e9f71106-0000-4000-8000-00000000000c";

async function waitForReceivedMarker(sessionId: string, requestId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const text = await fs.readFile(sessionEventActivePath(sessionId), "utf8").catch(() => "");
    if (
      text.split("\n").some((line) => line.includes("acpx/received") && line.includes(requestId))
    ) {
      return;
    }
    assert(Date.now() < deadline, `the acpx/received marker for ${requestId} never reached disk`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("P1 (c) REAL TURN: a completed pi turn persists acpx.pi_transcript_bytes = the transcript's size, through the per-turn clone", async () => {
  await withTempHome("acpx-p1c-wm-turn-", async (home) => {
    const box = path.join(home, "box-agent");
    const cwd = path.join(home, "work");
    mkdirSync(cwd, { recursive: true });
    const linkDir = path.join(home, "bin", "pi-acp");
    mkdirSync(linkDir, { recursive: true });
    const mockLink = path.join(linkDir, "mock-agent.js");
    if (!existsSync(mockLink)) {
      await fs.symlink(MOCK_AGENT_PATH, mockLink);
    }
    const sessionId = "p1c-wm-turn";
    const acpSessionId = "acp-p1c-wm-turn";
    await writeSessionRecord(
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId,
        agentCommand: `node ${JSON.stringify(mockLink)} --supports-load-session`,
        cwd,
      }),
    );
    const transcript = plantPiTranscript(box, cwd, acpSessionId, 777);
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => true,
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async () => ({ configOptions: [] }),
      setDepth: async (requested: string): Promise<DepthProjection> => ({
        kind: "send-nothing",
        requested,
      }),
      queryActiveTurn: () => false,
    });
    const socket = await connectSocket(lease.socketPath);
    const lines = readline.createInterface({ input: socket });
    const previousBox = process.env.ACPX_PI_BOX_AGENT_DIR;
    process.env.ACPX_PI_BOX_AGENT_DIR = box;
    try {
      const requestId = `${sessionId}-request`;
      socket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId,
          ownerGeneration: lease.ownerGeneration,
          messageId: MESSAGE_ID,
          message: "echo hello",
          permissionMode: "approve-all",
          waitForCompletion: false,
        })}\n`,
      );
      const accepted = (await nextJsonLine(lines[Symbol.asyncIterator]())) as { type: string };
      assert.equal(accepted.type, "accepted");
      await waitForReceivedMarker(sessionId, requestId);
      const task = await owner.nextBatch().then((batch) => batch?.[0]);
      assert(task);
      await runQueuedTask(sessionId, [task], { suppressSdkConsoleErrors: true });
    } finally {
      if (previousBox === undefined) {
        delete process.env.ACPX_PI_BOX_AGENT_DIR;
      } else {
        process.env.ACPX_PI_BOX_AGENT_DIR = previousBox;
      }
      lines.close();
      socket.destroy();
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
    const raw = JSON.parse(
      await fs.readFile(path.join(home, ".acpx", "sessions", `${sessionId}.json`), "utf8"),
    ) as { acp_session_id?: string; acpx?: { pi_transcript_bytes?: unknown } };
    assert.equal(raw.acp_session_id, acpSessionId, "control: the turn loaded the same session");
    assert.equal(
      raw.acpx?.pi_transcript_bytes,
      (await fs.stat(transcript)).size,
      "the completed turn's floor is missing from the persisted record",
    );
  });
});
