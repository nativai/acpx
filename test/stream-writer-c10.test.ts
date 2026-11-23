import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { defaultSessionEventLog, sessionEventActivePath } from "../src/session/event-log.js";
import {
  SessionEventWriter,
  STREAM_WRITE_PART_BYTES,
  acquireEventsLock,
  appendInParts,
} from "../src/session/events.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { setPodLockDepsForTests } from "../src/session/persistence/identity-file-lock.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";
import { withTempHome as sharedWithTempHome } from "./temp-home.js";

function withTempHome(prefix: string, run: (homeDir: string) => Promise<void>): Promise<void> {
  return sharedWithTempHome(prefix, run, { pin: ["HOME"] });
}

// block A8 (brick 88112988): C10's writer rule (one write per flush, parts of at most 1 MiB with a
// data sync between them) and G1 (the stream writer lock is A5's primitive: pod-aware judging, never
// broken by age across pods).

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

/** Counts every FileHandle write/datasync and open of the stream file, through the shared `fs/promises`. */
function probeHandles(): {
  writes: number[];
  syncs: () => number;
  opens: () => number;
  stop: () => void;
} {
  const writes: number[] = [];
  let syncs = 0;
  let opens = 0;
  const realOpen = fsp.open;
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith(".stream.ndjson") || String(args[0]).includes("stream")) {
      opens += 1;
      const realWriteFn = handle.write.bind(handle);
      const realSync = handle.datasync.bind(handle);
      (handle as { write: unknown }).write = async (...a: unknown[]) => {
        const out = await (realWriteFn as (...x: unknown[]) => Promise<{ bytesWritten: number }>)(
          ...a,
        );
        writes.push(out.bytesWritten);
        return out;
      };
      (handle as { datasync: unknown }).datasync = async () => {
        syncs += 1;
        return await realSync();
      };
    }
    return handle;
  }) as typeof fsp.open;
  return { writes, syncs: () => syncs, opens: () => opens, stop: () => void (fsp.open = realOpen) };
}

test("a flush of N frames is ONE open and ONE write, and every frame is on disk in order", async () => {
  await withTempHome("acpx-c10-one-", async (homeDir) => {
    const rec = record("c10-one", homeDir);
    await writeSessionRecord(rec);
    const writer = await SessionEventWriter.open(rec);
    const probe = probeHandles();
    try {
      await writer.appendMessages([frame(1), frame(2), frame(3), frame(4), frame(5)]);
    } finally {
      probe.stop();
    }
    assert.equal(probe.opens(), 1, "one open-append-close for the flush");
    assert.equal(probe.writes.length, 1, "one write for the whole flush");
    assert.equal(probe.syncs(), 0, "a small flush needs no data sync");
    const lines = (await fsp.readFile(sessionEventActivePath("c10-one"), "utf8"))
      .trim()
      .split("\n");
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as { params: { n: number } }).params.n),
      [1, 2, 3, 4, 5],
    );
    assert.equal(writer.getRecord().lastSeq, 5);
    await writer.close();
  });
});

test("an event above 1 MiB is written in parts of at most 1 MiB with a data sync between them, whole on disk", async () => {
  await withTempHome("acpx-c10-split-", async (homeDir) => {
    const rec = record("c10-big", homeDir, 64 * 1024 * 1024);
    await writeSessionRecord(rec);
    const writer = await SessionEventWriter.open(rec);
    const probe = probeHandles();
    const big = frame(1, Math.floor(2.5 * 1024 * 1024));
    try {
      await writer.appendMessages([big, frame(2)]);
    } finally {
      probe.stop();
    }
    assert.ok(probe.writes.length >= 3, `expected ≥3 parts, got ${probe.writes.length}`);
    assert.ok(
      probe.writes.every((bytes) => bytes <= STREAM_WRITE_PART_BYTES),
      `a part exceeded 1 MiB: ${probe.writes.join(",")}`,
    );
    assert.equal(
      probe.syncs(),
      probe.writes.length - 1,
      "a data sync between parts, none after the last",
    );
    const text = await fsp.readFile(sessionEventActivePath("c10-big"), "utf8");
    assert.ok(text.endsWith("\n"));
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(
      (JSON.parse(lines[0] ?? "") as { params: { pad: string } }).params.pad.length,
      (big as unknown as { params: { pad: string } }).params.pad.length,
    );
    await writer.close();
  });
});

test("appendInParts: exact boundaries — a buffer of exactly 1 MiB is one write; one byte more is two", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-c10-parts-"));
  for (const [size, parts] of [
    [STREAM_WRITE_PART_BYTES, 1],
    [STREAM_WRITE_PART_BYTES + 1, 2],
  ] as const) {
    const file = path.join(dir, `p${size}.stream`);
    const probe = probeHandles();
    try {
      await appendInParts(file, Buffer.alloc(size, 0x61));
    } finally {
      probe.stop();
    }
    assert.equal(probe.writes.length, parts, `size ${size}`);
    assert.equal(fs.statSync(file).size, size);
  }
});

test("a rotation inside a flush ends the group: each file still gets one write, nothing is lost or split across a segment", async () => {
  await withTempHome("acpx-c10-rotate-", async (homeDir) => {
    const rec = record("c10-rot", homeDir, 700);
    await writeSessionRecord(rec);
    const writer = await SessionEventWriter.open(rec);
    const probe = probeHandles();
    try {
      await writer.appendMessages([frame(1, 300), frame(2, 300), frame(3, 300), frame(4, 300)]);
    } finally {
      probe.stop();
    }
    assert.equal(probe.opens(), probe.writes.length, "one write per open");
    assert.ok(probe.opens() >= 2, "the batch crossed a segment boundary");
    const { listSessionEvents } = await import("../src/session/events.js");
    const events = await listSessionEvents("c10-rot");
    assert.deepEqual(
      events.map((event) => (event as unknown as { params: { n: number } }).params.n),
      [1, 2, 3, 4],
    );
    await writer.close();
  });
});

test("NEGATIVE: a batch holding one invalid frame writes none of it", async () => {
  await withTempHome("acpx-c10-invalid-", async (homeDir) => {
    const rec = record("c10-bad", homeDir);
    await writeSessionRecord(rec);
    const writer = await SessionEventWriter.open(rec);
    await assert.rejects(
      writer.appendMessages([frame(1), { nope: true } as unknown as AcpJsonRpcMessage, frame(3)]),
      /invalid ACP JSON-RPC/,
    );
    assert.equal(fs.existsSync(sessionEventActivePath("c10-bad")), false, "no byte of the batch");
    assert.equal(writer.getRecord().lastSeq, 0);
    await writer.close();
  });
});

test("NEGATIVE: a holder whose lock was taken from it does not publish its flush (A-4: check before publish)", async () => {
  await withTempHome("acpx-c10-lost-", async (homeDir) => {
    const rec = record("c10-lost", homeDir);
    await writeSessionRecord(rec);
    const writer = await SessionEventWriter.open(rec);
    const lockPath = path.join(
      path.dirname(sessionEventActivePath("c10-lost")),
      "c10-lost.stream.lock",
    );
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, token: "someone-else" }));
    await assert.rejects(writer.appendMessages([frame(1)]), { code: "lock-lost" });
    assert.equal(fs.existsSync(sessionEventActivePath("c10-lost")), false);
  });
});

// ---- G1: the stream writer lock on A5's primitive ----

const OWN = { name: "ag-own", uid: "uid-own", node: "node-a", namespace: "ns" };
const OTHER = { name: "ag-other", uid: "uid-other", node: "node-b", namespace: "ns" };

function foreignBody(createdAtMs: number): string {
  return JSON.stringify({
    pid: 4242,
    created_at: new Date(createdAtMs).toISOString(),
    host: "elsewhere",
    pod: OTHER,
    token: "other-token",
  });
}

function podSandbox(place: "control" | "agent-pod", proof: "exists" | "gone"): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-g1-"));
  process.env.ACPX_POD_TEST_HOME = home;
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    podModeRequested: () => false,
    place: () => place,
    proveDeath: async () =>
      proof === "gone" ? { answer: "gone", proof: "pod-gone" } : { answer: "exists" },
  });
}

function restorePod(): void {
  setPodLockDepsForTests(undefined);
  delete process.env.ACPX_POD_TEST_HOME;
}

test("G1 NEVER: a stream lock held in another pod is not broken by age — even an hour old, from the control pod", async () => {
  await withTempHome("acpx-g1-age-", async (homeDir) => {
    podSandbox("control", "exists");
    try {
      const lockPath = path.join(homeDir, ".acpx", "sessions", "g1-age.stream.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const raw = foreignBody(Date.now() - 3_600_000);
      fs.writeFileSync(lockPath, raw);
      await assert.rejects(acquireEventsLock("g1-age", 800), { code: "stream-lock-timeout" });
      assert.equal(fs.readFileSync(lockPath, "utf8"), raw, "the lock is byte-identical");
    } finally {
      restorePod();
    }
  });
});

test("G1: the control pod breaks another pod's stream lock on PROOF its pod is gone", async () => {
  await withTempHome("acpx-g1-gone-", async (homeDir) => {
    podSandbox("control", "gone");
    try {
      const lockPath = path.join(homeDir, ".acpx", "sessions", "g1-gone.stream.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, foreignBody(Date.now()));
      const lock = await acquireEventsLock("g1-gone", 3_000);
      assert.match(fs.readFileSync(lock.filePath, "utf8"), /uid-own/, "now held by this pod");
    } finally {
      restorePod();
    }
  });
});

test("G1 NEVER: an agent pod breaks no foreign stream lock, even one whose pod is proven gone", async () => {
  await withTempHome("acpx-g1-agent-", async (homeDir) => {
    podSandbox("agent-pod", "gone");
    try {
      const lockPath = path.join(homeDir, ".acpx", "sessions", "g1-agent.stream.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const raw = foreignBody(Date.now() - 3_600_000);
      fs.writeFileSync(lockPath, raw);
      await assert.rejects(acquireEventsLock("g1-agent", 800), { code: "stream-lock-timeout" });
      assert.equal(fs.readFileSync(lockPath, "utf8"), raw);
    } finally {
      restorePod();
    }
  });
});

test("G1: the control pod's sweep removes a stream lock whose pod is gone — and leaves one whose pod exists", async () => {
  const { sweepOwnPodLocks } = await import("../src/session/persistence/identity-file-lock.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-g1-sweep-"));
  const lock = path.join(dir, "sw.stream.lock");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-g1-sweep-home-"));
  const savedState = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  try {
    for (const [proof, removed] of [
      ["exists", false],
      ["gone", true],
    ] as const) {
      podSandbox("control", proof);
      fs.writeFileSync(lock, foreignBody(Date.now()));
      const result = await sweepOwnPodLocks({ dirs: [dir] });
      assert.equal(result.removed.length, removed ? 1 : 0, `proof ${proof}`);
      assert.equal(fs.existsSync(lock), !removed);
      fs.rmSync(lock, { force: true });
    }
  } finally {
    restorePod();
    if (savedState === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = savedState;
    }
  }
});
