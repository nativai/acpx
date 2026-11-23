import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { defaultSessionEventLog, sessionEventActivePath } from "../src/session/event-log.js";
import {
  SessionEventWriter,
  STREAM_WRITE_PART_BYTES,
  listSessionEvents,
  streamHoldMarkerForTest,
} from "../src/session/events.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";
import { withTempHome as sharedWithTempHome } from "./temp-home.js";

function withTempHome(prefix: string, run: (homeDir: string) => Promise<void>): Promise<void> {
  return sharedWithTempHome(prefix, run, { pin: ["HOME"] });
}

// brick eef0805f (the A8 TE's F1, pre-existing on dev e09bfb0d): a writer SIGKILLed mid-line leaves a
// partial line with no newline. The NEXT writer used to append its first frame straight after it, and a
// reader that splits on newline lost that frame. Now a writer that finds a tail with no newline puts ONE
// newline in front of its first append: the partial line is one damaged line and no good frame is lost.

function record(id: string, cwd: string, maxSegmentBytes?: number): SessionRecord {
  const now = "2026-02-28T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: id,
    acpSessionId: id,
    agentCommand: AGENT_REGISTRY.codex,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: {
      ...defaultSessionEventLog(id),
      max_segments: 3,
      segment_count: 1,
      ...(maxSegmentBytes ? { max_segment_bytes: maxSegmentBytes } : {}),
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
}

function frame(n: number, pad = 0): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { n, pad: "x".repeat(pad) },
  } as AcpJsonRpcMessage;
}

function numbers(events: AcpJsonRpcMessage[]): number[] {
  return events.map((event) => (event as { params: { n: number } }).params.n);
}

/** Splits the way a reader does: on newline, a final empty piece after the last newline dropped. */
function rawLines(payload: string): string[] {
  const pieces = payload.split("\n");
  assert.equal(pieces.at(-1), "", "the file ends with a newline");
  return pieces.slice(0, -1);
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

const CHILD_SOURCE = `
const [eventsUrl, persistenceUrl, id] = process.argv.slice(1);
const events = await import(eventsUrl);
const persistence = await import(persistenceUrl);
const rec = await persistence.resolveSessionRecord(id);
const writer = await events.SessionEventWriter.open(rec);
const frame = (n, pad) => ({ jsonrpc: "2.0", method: "session/update", params: { n, pad: "x".repeat(pad) } });
await writer.appendMessages([frame(1, 0)]);
// An event above 1 MiB goes out in parts; the seam holds the process after the first part is synced.
await writer.appendMessages([frame(2, 2.5 * 1024 * 1024)]);
`;

/**
 * A REAL writer process: it appends frame 1, then a 2.5 MiB frame 2 in parts, and the hold seam stops it
 * after the first part is on disk. Resolves once the stream ends mid-line, with the process still alive
 * and holding the stream lock; the caller SIGKILLs it.
 */
async function startWriterHeldMidLine(
  homeDir: string,
  id: string,
): Promise<{ child: ChildProcess; marker: string }> {
  const marker = path.join(homeDir, `${id}.hold-marker`);
  const here = import.meta.url;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHILD_SOURCE,
      new URL("../src/session/events.js", here).href,
      new URL("../src/session/persistence.js", here).href,
      id,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ACPX_TEST_STREAM_HOLD_MID_LINE: marker },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(marker)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      assert.fail(`the writer child never reached the hold (exit=${child.exitCode}): ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, marker };
}

async function killAndWait(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal(child.kill("SIGKILL"), true, "the writer is killed");
  await exited;
}

test("a REAL writer SIGKILLed mid-line: the next writer's first frame is read, and exactly ONE line is damaged", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-partial-line-", async (homeDir) => {
    const id = "partial-line";
    await writeSessionRecord(record(id, homeDir, 64 * 1024 * 1024));
    const { child } = await startWriterHeldMidLine(homeDir, id);
    const active = sessionEventActivePath(id);

    const before = await fsp.readFile(active);
    assert.ok(before.length > STREAM_WRITE_PART_BYTES, "the first part of frame 2 is on disk");
    assert.notEqual(before.at(-1), 0x0a, "the dead writer's tail is a PARTIAL line (no newline)");
    await killAndWait(child);

    // The second writer: a different process (this one), the dead holder's lock broken on proof.
    const rec = await resolveSessionRecord(id);
    const second = await SessionEventWriter.open(rec);
    await second.appendMessages([frame(3)]);
    await second.appendMessages([frame(4), frame(5)]);
    await second.close({ checkpoint: false });

    const payload = await fsp.readFile(active, "utf8");
    const lines = rawLines(payload);
    assert.equal(
      lines.filter((line) => line.trim() === "").length,
      0,
      "no empty line: the tail was closed once, not once per flush",
    );
    assert.equal(
      lines.filter((line) => !parses(line)).length,
      1,
      "exactly ONE line is damaged — the dead writer's partial frame 2",
    );
    assert.deepEqual(
      numbers(await listSessionEvents(id)),
      [1, 3, 4, 5],
      "the reader gets frame 1 and EVERY frame of the second writer, the first one included",
    );
  });
});

test("a tail that already ends in a newline gets NO extra newline (no empty line)", async () => {
  await withTempHome("acpx-partial-line-clean-", async (homeDir) => {
    const id = "clean-tail";
    const rec = record(id, homeDir);
    await writeSessionRecord(rec);
    const first = await SessionEventWriter.open(rec);
    await first.appendMessages([frame(1), frame(2)]);
    await first.close({ checkpoint: false });
    const before = await fsp.readFile(sessionEventActivePath(id), "utf8");

    const second = await SessionEventWriter.open(rec);
    await second.appendMessages([frame(3)]);
    await second.close({ checkpoint: false });

    const after = await fsp.readFile(sessionEventActivePath(id), "utf8");
    assert.equal(
      after,
      `${before}${JSON.stringify(frame(3))}\n`,
      "the file grew by frame 3's line only",
    );
    assert.equal(rawLines(after).filter((line) => line === "").length, 0);
  });
});

test("an EMPTY stream file is unchanged by the check: the first bytes are the first frame", async () => {
  await withTempHome("acpx-partial-line-empty-", async (homeDir) => {
    const id = "empty-file";
    const rec = record(id, homeDir);
    await writeSessionRecord(rec);
    await fsp.mkdir(path.dirname(sessionEventActivePath(id)), { recursive: true });
    await fsp.writeFile(sessionEventActivePath(id), "");

    const writer = await SessionEventWriter.open(rec);
    await writer.appendMessages([frame(1)]);
    await writer.close({ checkpoint: false });

    assert.equal(
      await fsp.readFile(sessionEventActivePath(id), "utf8"),
      `${JSON.stringify(frame(1))}\n`,
    );
  });
});

test("a COMPLETE line is never cut: a tail that ends mid-line is only followed by a newline, byte for byte", async () => {
  await withTempHome("acpx-partial-line-bytes-", async (homeDir) => {
    const id = "bytes";
    const rec = record(id, homeDir);
    await writeSessionRecord(rec);
    await fsp.mkdir(path.dirname(sessionEventActivePath(id)), { recursive: true });
    const complete = `${JSON.stringify(frame(1))}\n`;
    const partial = `{"jsonrpc":"2.0","method":"session/upd`;
    await fsp.writeFile(sessionEventActivePath(id), `${complete}${partial}`);

    const writer = await SessionEventWriter.open(rec);
    await writer.appendMessages([frame(2)]);
    await writer.close({ checkpoint: false });

    assert.equal(
      await fsp.readFile(sessionEventActivePath(id), "utf8"),
      `${complete}${partial}\n${JSON.stringify(frame(2))}\n`,
      "everything the dead writer left is intact; one newline, then the new frame",
    );
    assert.deepEqual(numbers(await listSessionEvents(id)), [1, 2]);
  });
});

test("a rotation before the first append: the partial tail goes to the segment, the new file starts clean, nothing is lost", async () => {
  await withTempHome("acpx-partial-line-rotate-", async (homeDir) => {
    const id = "rotate";
    const rec = record(id, homeDir, 200);
    await writeSessionRecord(rec);
    await fsp.mkdir(path.dirname(sessionEventActivePath(id)), { recursive: true });
    const complete = `${JSON.stringify(frame(1))}\n`;
    await fsp.writeFile(sessionEventActivePath(id), `${complete}{"jsonrpc":"2.0","meth`);

    const writer = await SessionEventWriter.open(rec);
    await writer.appendMessages([frame(2, 300)]);
    await writer.appendMessages([frame(3)]);
    await writer.close({ checkpoint: false });

    assert.deepEqual(numbers(await listSessionEvents(id)), [1, 2, 3]);
    const active = await fsp.readFile(sessionEventActivePath(id), "utf8");
    assert.equal(rawLines(active).filter((line) => !parses(line)).length, 0);
  });
});

test("listSessionEvents tolerates the one damaged line anywhere in a file and returns every good frame", async () => {
  await withTempHome("acpx-partial-line-reader-", async () => {
    const id = "reader";
    await fsp.mkdir(path.dirname(sessionEventActivePath(id)), { recursive: true });
    await fsp.writeFile(
      sessionEventActivePath(id),
      `${JSON.stringify(frame(1))}\n{"jsonrpc":"2.0","method":"session/upd\n${JSON.stringify(frame(2))}\n`,
    );
    assert.deepEqual(numbers(await listSessionEvents(id)), [1, 2]);
  });
});

test("the hold seam is honoured only under NODE_TEST_CONTEXT", () => {
  const set = { ACPX_TEST_STREAM_HOLD_MID_LINE: "/tmp/marker" };
  assert.equal(streamHoldMarkerForTest({}), undefined);
  assert.equal(streamHoldMarkerForTest({ ...set }), undefined, "no test context: ignored");
  assert.equal(
    streamHoldMarkerForTest({ ...set, NODE_TEST_CONTEXT: "" }),
    undefined,
    "empty: ignored",
  );
  assert.equal(streamHoldMarkerForTest({ NODE_TEST_CONTEXT: "child-v8" }), undefined, "no marker");
  assert.equal(streamHoldMarkerForTest({ ...set, NODE_TEST_CONTEXT: "child-v8" }), "/tmp/marker");
});
