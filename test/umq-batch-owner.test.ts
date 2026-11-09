// UMQ A1 (brick 0a6deb9a) — the queue owner's half of batching (CONCEPTION §5.1–§5.2, CONTRACTS K3) and the
// client's capability rule (§1.4). Rows are titled with their TEST-PLAN §4.1 ids.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { BatchFileMember } from "../src/cli/batch-file.js";
import {
  type QueueTask,
  SessionQueueOwner,
  trySubmitBatchToRunningOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import {
  ownerSupportsBatchSubmit,
  readQueueOwnerProcessIdentity,
  readQueueOwnerRecord,
} from "../src/cli/queue/lease-store.js";
import { queueLockFilePath, queueSocketPath } from "../src/cli/queue/paths.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import type { OutputFormatter } from "../src/types.js";
import { connectSocket, withTempHome } from "./queue-test-helpers.js";

const NOOP_CONTROL_HANDLERS = {
  cancelPrompt: async () => false,
  closeSession: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
  setDepth: async (requested: string): Promise<DepthProjection> => ({
    kind: "send-nothing",
    requested,
  }),
  queryActiveTurn: () => false,
};

function memberId(n: number): string {
  return `0a6deb9a-1111-4000-8000-${String(n).padStart(12, "0")}`;
}

function batchRequest(
  generation: number | undefined,
  count: number,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "submit_prompt_batch",
    requestId: "req-batch",
    ownerGeneration: generation,
    members: Array.from({ length: count }, (_unused, index) => ({
      messageId: memberId(index + 1),
      message: `m${index + 1}`,
      prompt: [{ type: "text", text: `m${index + 1}` }],
    })),
    permissionMode: "approve-all",
    waitForCompletion: false,
    ...extra,
  };
}

function singleRequest(requestId: string, generation: number | undefined, text = requestId) {
  return {
    type: "submit_prompt",
    requestId,
    ownerGeneration: generation,
    message: text,
    permissionMode: "approve-all",
    waitForCompletion: false,
  };
}

/** One request, every reply line until the owner ends the socket. */
async function exchange(socketPath: string, request: unknown): Promise<unknown[]> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  const replies: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    lines.on("line", (line) => {
      if (line.trim().length > 0) {
        replies.push(JSON.parse(line));
      }
    });
    socket.once("close", () => resolve());
  });
  socket.write(`${JSON.stringify(request)}\n`);
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  lines.close();
  socket.destroy();
  return replies;
}

async function receivedMarkers(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(sessionEventActivePath(sessionId), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    .filter((line) => line.method === "acpx/received")
    .map((line) => line.params ?? {});
}

async function withOwner(
  sessionId: string,
  maxQueueDepth: number,
  body: (owner: SessionQueueOwner, socketPath: string, generation: number) => Promise<void>,
): Promise<void> {
  await withTempHome(async () => {
    // The owner's `acpx/received` markers are fire-and-forget appends into the sessions dir.
    await fs.mkdir(path.dirname(sessionEventActivePath(sessionId)), { recursive: true });
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, NOOP_CONTROL_HANDLERS, { maxQueueDepth });
    try {
      await body(owner, lease.socketPath, lease.ownerGeneration);
    } finally {
      await owner.close();
    }
  });
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 200 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}

test("C§1.4: this build's owners advertise submit_prompt_batch in their lease", async () => {
  await withOwner("umq-owner-lease-features", 16, async () => {
    const record = await readQueueOwnerRecord("umq-owner-lease-features");
    assert.deepEqual(record?.protocolFeatures, ["submit_prompt_batch"]);
    assert.equal(ownerSupportsBatchSubmit(record), true);
  });
});

test("N-A1-3: protocolFeatures is honoured only as an array of strings", () => {
  const base = {
    pid: 1,
    sessionId: "s",
    socketPath: "/x",
    createdAt: "t",
    heartbeatAt: "t",
    ownerGeneration: 1,
    queueDepth: 0,
  };
  assert.equal(ownerSupportsBatchSubmit(base), false, "absent");
  assert.equal(ownerSupportsBatchSubmit(undefined), false);
  assert.equal(
    ownerSupportsBatchSubmit({
      ...base,
      protocolFeatures: ["future-thing", "submit_prompt_batch"],
    }),
    true,
    "an unknown extra string still matches the known one",
  );
});

test("N-A1-3 (reader): a lease whose protocolFeatures is a string, or [42], is read as lacking the feature", async () => {
  await withTempHome(async () => {
    const sessionId = "umq-lease-reader";
    const lockPath = queueLockFilePath(sessionId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const lease = {
      pid: process.pid,
      sessionId,
      socketPath: queueSocketPath(sessionId),
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerGeneration: 7,
      queueDepth: 0,
    };
    for (const protocolFeatures of ["submit_prompt_batch", [42], { submit_prompt_batch: true }]) {
      await fs.writeFile(lockPath, `${JSON.stringify({ ...lease, protocolFeatures })}\n`);
      const record = await readQueueOwnerRecord(sessionId);
      assert.ok(record, "the lease itself still parses");
      assert.equal(ownerSupportsBatchSubmit(record), false, JSON.stringify(protocolFeatures));
    }
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ...lease, protocolFeatures: [42, "submit_prompt_batch"] })}\n`,
    );
    assert.equal(ownerSupportsBatchSubmit(await readQueueOwnerRecord(sessionId)), true);
  });
});

test("N-A1-5 (a): a 20-member batch to an owner with depth 16 is accepted as ONE submission", async () => {
  await withOwner("umq-depth-batch", 16, async (owner, socketPath, generation) => {
    const replies = await exchange(socketPath, batchRequest(generation, 20));
    assert.deepEqual(
      replies.map((reply) => (reply as { type: string }).type),
      ["accepted"],
    );
    const markers = await waitFor(
      async () => await receivedMarkers("umq-depth-batch"),
      (lines) => lines.length >= 20,
    );
    assert.equal(markers.length, 20, "one acpx/received per member");
    assert.deepEqual(
      markers.map((marker) => marker.requestId),
      Array.from({ length: 20 }, (_unused, index) => `req-batch#${index}`),
    );
    assert.equal(owner.queueDepth(), 20, "N tasks");
    const batch = await owner.nextBatch(0);
    assert.equal(batch?.length, 20, "a parked runtime takes the whole batch at once");
    assert.deepEqual(
      batch?.map((task) => task.messageId),
      Array.from({ length: 20 }, (_unused, index) => memberId(index + 1)),
    );
  });
});

test("N-A1-5 (b): a single submit while 16 submissions are pending is refused BEFORE accepted — no acpx/received, nothing enqueued", async () => {
  await withOwner("umq-depth-single", 16, async (owner, socketPath, generation) => {
    for (let n = 0; n < 16; n += 1) {
      const replies = await exchange(socketPath, singleRequest(`fill-${n}`, generation));
      assert.equal((replies[0] as { type: string }).type, "accepted", `fill ${n}`);
    }
    const filled = await waitFor(
      async () => await receivedMarkers("umq-depth-single"),
      (lines) => lines.length >= 16,
    );
    assert.equal(filled.length, 16, "planted positive: accepted submits DO leave their marker");
    const replies = await exchange(socketPath, singleRequest("over", generation));
    assert.equal(replies.length, 1, "no accepted frame first");
    assert.deepEqual(
      {
        type: (replies[0] as { type: string }).type,
        detailCode: (replies[0] as { detailCode?: string }).detailCode,
        retryable: (replies[0] as { retryable?: boolean }).retryable,
      },
      { type: "error", detailCode: "QUEUE_OWNER_OVERLOADED", retryable: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const markers = await receivedMarkers("umq-depth-single");
    assert.equal(
      markers.some((marker) => marker.requestId === "over"),
      false,
      "no acpx/received line for the refused submit",
    );
    assert.equal(owner.queueDepth(), 16, "nothing enqueued");
  });
});

test("N-A1-5 (c): a batch counts as ONE submission toward depth — 15 singles + a batch of 5 fill 16", async () => {
  await withOwner("umq-depth-count", 16, async (owner, socketPath, generation) => {
    for (let n = 0; n < 15; n += 1) {
      await exchange(socketPath, singleRequest(`fill-${n}`, generation));
    }
    const batchReplies = await exchange(socketPath, batchRequest(generation, 5));
    assert.equal((batchReplies[0] as { type: string }).type, "accepted", "the 16th submission");
    assert.equal(owner.queueDepth(), 20, "20 tasks queued");
    const refused = await exchange(socketPath, singleRequest("over", generation));
    assert.equal((refused[0] as { detailCode?: string }).detailCode, "QUEUE_OWNER_OVERLOADED");
  });
});

test("C§1.3: a malformed batch (a duplicate member messageId) is refused QUEUE_REQUEST_INVALID before accepted", async () => {
  await withOwner("umq-batch-invalid", 16, async (owner, socketPath, generation) => {
    const request = batchRequest(generation, 2);
    request.members[1].messageId = request.members[0].messageId;
    const replies = await exchange(socketPath, request);
    assert.deepEqual(
      replies.map((reply) => (reply as { detailCode?: string; type: string }).detailCode ?? "-"),
      ["QUEUE_REQUEST_INVALID"],
    );
    assert.equal(owner.queueDepth(), 0);
  });
});

test("N-A1-1 (owner half): a batch of ONE keeps the plain requestId — no #0", async () => {
  await withOwner("umq-batch-of-one", 16, async (owner, socketPath, generation) => {
    await exchange(socketPath, batchRequest(generation, 1));
    const batch = await owner.nextBatch(0);
    assert.equal(batch?.length, 1);
    assert.equal(batch?.[0]?.requestId, "req-batch");
  });
});

test("G5: a runtime parked in nextBatch is woken with the WHOLE batch, not its first task", async () => {
  await withOwner("umq-parked-waiter", 16, async (owner, socketPath, generation) => {
    const parked = owner.nextBatch(5_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await exchange(socketPath, batchRequest(generation, 3));
    const batch = await parked;
    assert.deepEqual(
      batch?.map((task) => task.requestId),
      ["req-batch#0", "req-batch#1", "req-batch#2"],
    );
    assert.equal(owner.queueDepth(), 0);
  });
});

test("N-A1-9 (owner half): a batch arriving during a turn is handed to the mid-turn handler ONCE, whole; two submissions twice", async () => {
  await withOwner("umq-midturn-owner", 16, async (owner, socketPath, generation) => {
    const handed: string[][] = [];
    owner.setMidTurnHandler(
      (tasks) => {
        handed.push(tasks.map((task) => task.requestId));
        return true;
      },
      () => true,
    );
    await exchange(socketPath, batchRequest(generation, 3));
    await exchange(socketPath, singleRequest("solo-a", generation));
    await exchange(socketPath, singleRequest("solo-b", generation));
    assert.deepEqual(handed, [
      ["req-batch#0", "req-batch#1", "req-batch#2"],
      ["solo-a"],
      ["solo-b"],
    ]);
  });
});

function directTask(requestId: string, overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    requestId,
    messageId: `${requestId}-id`,
    message: requestId,
    prompt: [{ type: "text", text: requestId }],
    permissionMode: "approve-all",
    waitForCompletion: false,
    enqueuedAt: 1_000,
    send: () => {},
    close: () => {},
    ...overrides,
  };
}

async function drainBatches(owner: SessionQueueOwner): Promise<string[][]> {
  const batches: string[][] = [];
  for (let batch = await owner.nextBatch(0); batch; batch = await owner.nextBatch(0)) {
    batches.push(batch.map((task) => task.requestId));
  }
  return batches;
}

test("N-A1-6: a slash command with options equal to the head's is always a batch of one", async () => {
  await withOwner("umq-slash", 16, async (owner) => {
    owner.requeueAll([
      directTask("a"),
      directTask("slash", { prompt: [{ type: "text", text: "/compact now" }] }),
      directTask("b"),
      directTask("c"),
    ]);
    assert.deepEqual(await drainBatches(owner), [["a"], ["slash"], ["b", "c"]]);
    owner.requeueAll([
      directTask("slash-head", { prompt: [{ type: "text", text: "  /clear" }] }),
      directTask("d"),
    ]);
    assert.deepEqual(await drainBatches(owner), [["slash-head"], ["d"]]);
  });
});

test("N-A1-8: tasks differing in ANY turn-shaping option are never one batch", async () => {
  const differing: Array<[string, Partial<QueueTask>]> = [
    ["waitForCompletion", { waitForCompletion: true }],
    ["permissionMode", { permissionMode: "approve-reads" }],
    ["resumePolicy", { resumePolicy: "same-session-only" }],
    ["nonInteractivePermissions", { nonInteractivePermissions: "fail" }],
    [
      "permissionPolicy",
      { permissionPolicy: { allow: ["Read"] } as QueueTask["permissionPolicy"] },
    ],
    ["sessionOptions", { sessionOptions: { model: "haiku" } }],
    ["timeoutMs", { timeoutMs: 5_000 }],
    ["promptRetries", { promptRetries: 2 }],
    ["codexSubscriptionCapWeeklyPercent", { codexSubscriptionCapWeeklyPercent: 50 }],
    ["suppressSdkConsoleErrors", { suppressSdkConsoleErrors: true }],
  ];
  await withOwner("umq-batch-key", 16, async (owner) => {
    for (const [option, override] of differing) {
      owner.requeueAll([directTask("head"), directTask("other", override)]);
      assert.deepEqual(await drainBatches(owner), [["head"], ["other"]], option);
    }
    // Control: equal options (incl. an equal sessionOptions object in another key order) DO batch.
    owner.requeueAll([
      directTask("x", { sessionOptions: { model: "haiku", maxTurns: 3 } }),
      directTask("y", { sessionOptions: { maxTurns: 3, model: "haiku" } }),
    ]);
    assert.deepEqual(await drainBatches(owner), [["x", "y"]]);
  });
});

// --- N-A1-2: an owner of an OLDER build -------------------------------------------------------------

const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/queue/old-owner-unknown-type-reply.json", import.meta.url),
);

// A separate PROCESS standing in for a 5c21f164 queue owner: it answers `submit_prompt` with `accepted`
// (a no-wait submit's whole exchange) and ANY other type with the reply bytes a real 5c21f164 owner was
// captured giving `submit_prompt_batch` (test/fixtures/queue/old-owner-unknown-type-reply.json; capture:
// /wisdom/Bricks/ec35727c-f2cf-4075-bc4a-6174400ea087/verification/A1-old-owner/), with only its
// `ownerGeneration` replaced by this lease's. Every request line is appended to LOG.
const OLD_OWNER_SCRIPT = `
import fs from "node:fs";
import net from "node:net";
const { SOCKET, LOG, REPLY, GEN } = process.env;
const reply = JSON.parse(REPLY);
reply.ownerGeneration = Number(GEN);
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const end = buffer.indexOf("\\n");
    if (end < 0) return;
    const line = buffer.slice(0, end);
    buffer = "";
    fs.appendFileSync(LOG, line + "\\n");
    const request = JSON.parse(line);
    if (request.type === "submit_prompt") {
      socket.end(JSON.stringify({ type: "accepted", requestId: request.requestId, ownerGeneration: Number(GEN) }) + "\\n");
      return;
    }
    socket.end(JSON.stringify(reply) + "\\n");
  });
  socket.on("error", () => {});
});
server.listen(SOCKET, () => process.stdout.write("ready\\n"));
`;

const SILENT_FORMATTER: OutputFormatter = {
  setContext: () => {},
  onAcpMessage: () => {},
  onError: () => {},
  onPermissionEscalation: () => {},
  flush: () => {},
};

function batchMembers(count: number): BatchFileMember[] {
  return Array.from({ length: count }, (_unused, index) => ({
    messageId: memberId(index + 1),
    prompt: [{ type: "text", text: `member ${index + 1}` }],
  }));
}

async function withOldOwner(
  protocolFeatures: readonly string[] | undefined,
  body: (rig: { sessionId: string; pid: number; generation: number; log: string }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const sessionId = "umq-old-owner";
    const fixture = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as { replyLine: string };
    const scriptPath = path.join(homeDir, "old-owner.mjs");
    const log = path.join(homeDir, "old-owner.requests.ndjson");
    await fs.writeFile(scriptPath, OLD_OWNER_SCRIPT);
    const socketPath = queueSocketPath(sessionId);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const generation = 424242;
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        SOCKET: socketPath,
        LOG: log,
        REPLY: fixture.replyLine,
        GEN: String(generation),
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout?.once("data", () => resolve());
        child.once("exit", (code) => reject(new Error(`stand-in owner exited ${code}`)));
      });
      assert(child.pid);
      const now = new Date().toISOString();
      const lockPath = queueLockFilePath(sessionId);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({
          pid: child.pid,
          sessionId,
          socketPath,
          createdAt: now,
          heartbeatAt: now,
          ownerGeneration: generation,
          queueDepth: 0,
          processIdentity: await readQueueOwnerProcessIdentity(child.pid),
          settingsRebind: 1,
          ...(protocolFeatures ? { protocolFeatures } : {}),
        })}\n`,
      );
      await body({ sessionId, pid: child.pid, generation, log });
    } finally {
      child.kill("SIGKILL");
    }
  });
}

async function loggedRequests(log: string): Promise<Array<{ type: string; messageId?: string }>> {
  const raw = await fs.readFile(log, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; messageId?: string });
}

test("N-A1-2: an owner whose lease lacks protocolFeatures is never sent submit_prompt_batch — N submit_prompts in order, and it stays alive", async () => {
  await withOldOwner(undefined, async ({ sessionId, pid, generation, log }) => {
    const outcome = await trySubmitBatchToRunningOwner({
      sessionId,
      members: batchMembers(3),
      permissionMode: "approve-all",
      outputFormatter: SILENT_FORMATTER,
    });
    assert.ok(outcome && "queued" in outcome, "accepted");
    const requests = await loggedRequests(log);
    assert.deepEqual(
      requests.map((request) => request.type),
      ["submit_prompt", "submit_prompt", "submit_prompt"],
      "never the unknown type",
    );
    assert.deepEqual(
      requests.map((request) => request.messageId),
      [memberId(1), memberId(2), memberId(3)],
      "in order",
    );
    process.kill(pid, 0);
    const lease = await readQueueOwnerRecord(sessionId);
    assert.equal(lease?.pid, pid, "the owner was not replaced");
    assert.equal(lease?.ownerGeneration, generation);
  });
});

// The control that proves the row above can fail: told (falsely) that this owner understands the batch,
// the client DOES send it, and gets the old build's answer — requestId "unknown", which the client reads
// as QUEUE_PROTOCOL_MALFORMED_MESSAGE, the stale-protocol code `trySubmitToRunningOwner` kills owners on.
test("N-A1-2 (control): with protocolFeatures listed the batch IS sent, and the old build answers it as a stale protocol", async () => {
  await withOldOwner(["submit_prompt_batch"], async ({ sessionId, log }) => {
    await assert.rejects(
      trySubmitBatchToRunningOwner({
        sessionId,
        members: batchMembers(2),
        permissionMode: "approve-all",
        outputFormatter: SILENT_FORMATTER,
      }),
      (error: unknown) =>
        (error as { detailCode?: string }).detailCode === "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
    );
    assert.deepEqual(
      (await loggedRequests(log)).map((request) => request.type),
      ["submit_prompt_batch"],
    );
  });
});
