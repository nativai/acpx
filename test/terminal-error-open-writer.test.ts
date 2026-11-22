import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { defaultSessionEventLog, sessionEventActivePath } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import { enforceModelFloorPostServe } from "../src/session/model-floor-enforce.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { setPodLockDepsForTests } from "../src/session/persistence/identity-file-lock.js";
import type { SessionRecord } from "../src/types.js";
import { withTempHome as sharedWithTempHome } from "./temp-home.js";

// block A8, TE finding F2 (brick 88112988): a terminal error persisted INSIDE a turn goes through the
// turn's OPEN stream writer — never a second `SessionEventWriter.open`, which would wait on (pod
// identity: throw `stream-lock-timeout` after 20 s) or steal (no identity: the turn writer's next flush
// fails `lock-lost`) the turn's own lock. The shape is `--floor-hard`'s post-serve refusal
// (`enforceModelFloorPostServe` → `refuseHardBelowFloor` → `persistTerminalTurnError`).
//
// ⚠️ THE CALL SITE (`runtime.ts`, `appendToStream`) IS ONE STATEMENT HERE REPRODUCED: this drives the REAL
// enforcement function with the same callback shape against a REAL open writer; a real Claude transcript
// (which `captureServedState` reads) is not fabricated.

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return sharedWithTempHome("acpx-f2-", run, { pin: ["HOME"] });
}

function hardPinnedRecord(id: string, cwd: string): SessionRecord {
  const now = "2026-02-28T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: id,
    acpSessionId: id,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: { ...defaultSessionEventLog(id), max_segments: 3, segment_count: 1 },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: { session_options: { model: "fable", floor_hard: true } },
  } as SessionRecord;
}

async function floorHardInsideATurn(homeDir: string, id: string): Promise<void> {
  const record = hardPinnedRecord(id, homeDir);
  await writeSessionRecord(record);
  const writer = await SessionEventWriter.open(record); // the turn's writer, holding the stream lock
  const lockPath = path.join(path.dirname(sessionEventActivePath(id)), `${id}.stream.lock`);
  const lockBefore = fs.readFileSync(lockPath, "utf8");
  await writer.appendMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: { n: 1 },
  } as never);
  const started = Date.now();
  const verdict = await enforceModelFloorPostServe(record, {
    servedModel: "claude-haiku-5",
    appendToStream: async (message) => {
      await writer.appendMessage(message, { checkpoint: false });
    },
  });
  const waitedMs = Date.now() - started;
  assert.equal(verdict.accept, false, "the --floor-hard refusal fired");
  assert.ok(
    waitedMs < 5_000,
    `no stream-lock wait: took ${waitedMs} ms (a second writer waits 20 s)`,
  );
  // the terminal error is IN the stream: a top-level JSON-RPC error response (acpx-ui's lastError)
  const lines = (await fsp.readFile(sessionEventActivePath(id), "utf8")).trim().split("\n");
  const last = JSON.parse(lines.at(-1) ?? "") as { error?: { data?: { detailCode?: string } } };
  assert.ok(last.error, "the terminal error response is the stream's tail");
  assert.equal(
    lines.length,
    2,
    "the turn's own frame, then the terminal error — nothing lost or doubled",
  );
  // the turn writer still owns its lock and its next flush works (no `lock-lost`)
  assert.equal(
    fs.readFileSync(lockPath, "utf8"),
    lockBefore,
    "the lock is byte-identical: nothing took it",
  );
  await writer.appendMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: { n: 2 },
  } as never);
  await writer.close({ checkpoint: false });
}

test("F2: outside pod mode, a --floor-hard post-serve refusal records its terminal error through the turn's open writer: no wait, no lock-lost", async () => {
  await withTempHome(async (homeDir) => {
    await floorHardInsideATurn(homeDir, "f2-plain");
  });
});

test("F2: with a pod identity (bodies carry `pod`) the same flow does not throw and does not wait", async () => {
  await withTempHome(async (homeDir) => {
    const pod = { name: "ag-f2", uid: "uid-f2", node: "node-a", namespace: "ns" };
    setPodLockDepsForTests({ ownPod: () => pod, lockPod: () => pod });
    try {
      await floorHardInsideATurn(homeDir, "f2-pod");
    } finally {
      setPodLockDepsForTests(undefined);
    }
  });
});

test("F2 NEGATIVE: the turn's lock body names its pod when an identity exists — so the lock above really was the strict kind", async () => {
  await withTempHome(async (homeDir) => {
    const pod = { name: "ag-f2", uid: "uid-f2b", node: "node-a", namespace: "ns" };
    setPodLockDepsForTests({ ownPod: () => pod, lockPod: () => pod });
    try {
      const record = hardPinnedRecord("f2-body", homeDir);
      await writeSessionRecord(record);
      const writer = await SessionEventWriter.open(record);
      const lockPath = path.join(
        path.dirname(sessionEventActivePath("f2-body")),
        "f2-body.stream.lock",
      );
      assert.match(fs.readFileSync(lockPath, "utf8"), /"uid":"uid-f2b"/u);
      await writer.close({ checkpoint: false });
    } finally {
      setPodLockDepsForTests(undefined);
    }
  });
});

// ---- the scan: every place that opens a stream writer, and why none can run beside an open turn writer ----

const SRC = new URL("../../src/", import.meta.url).pathname;
/** `SessionEventWriter.open(` call sites outside the class's own file, each with the reason it cannot overlap the turn's own writer of the SAME session. */
const WRITER_OPEN_SITES = new Map<string, { count: number; reason: string }>([
  [
    "session/persist-terminal-error.ts",
    {
      count: 1,
      reason:
        "only when no `appendToStream` is given: callers outside a turn (pre-submit, failover surfacing after the turn's writer closed)",
    },
  ],
  [
    "cli/session/queue-owner-runtime.ts",
    {
      count: 2,
      reason:
        "the owner's idle drain (stopped before a turn starts) and CHILD sessions' writers (another session's lock)",
    },
  ],
  [
    "cli/session/runtime.ts",
    {
      count: 4,
      reason:
        "the dedup delivery terminal (before the turn writer opens), the turn's own writer, the standalone writer after the turn writer closed, CHILD sessions' writers",
    },
  ],
]);

function* tsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* tsFiles(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

export function openSiteCount(text: string): number {
  return text.match(/SessionEventWriter\.open\(/gu)?.length ?? 0;
}

test("SCAN: every SessionEventWriter.open call site is registered with its reason — a new one must be reviewed for overlap with a turn writer", () => {
  const found = new Map<string, number>();
  for (const file of tsFiles(SRC)) {
    const rel = path.relative(SRC, file);
    if (rel === "session/events.ts") {
      continue;
    }
    const count = openSiteCount(fs.readFileSync(file, "utf8"));
    if (count > 0) {
      found.set(rel, count);
    }
  }
  assert.deepEqual(
    [...found].map(([rel, count]) => `${rel}:${count}`).toSorted((a, b) => a.localeCompare(b)),
    [...WRITER_OPEN_SITES]
      .map(([rel, site]) => `${rel}:${site.count}`)
      .toSorted((a, b) => a.localeCompare(b)),
  );
  // negative case: a fresh file with an unregistered open would make the maps differ
  assert.equal(openSiteCount(`const w = await SessionEventWriter.open(record);`), 1);
});
