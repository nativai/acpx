import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import {
  appendDeliveryStreamEvent,
  appendDeliveryStreamEventSync,
  appendRefusedStreamEventSync,
} from "../src/cli/queue/ipc.js";
import { appendClearedBackgroundTasksLine } from "../src/cli/session/owner-task-reap.js";
import { DELIVERY_EVENT_METHOD, hasCompletedDeliveryFor } from "../src/session/delivery-events.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { SessionEventWriter, listSessionEvents } from "../src/session/events.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage } from "../src/types.js";
import {
  envWithout,
  frame,
  frameNumbers,
  killAndWait,
  leaveDeadWriterMidLine,
  methodsOf,
  releaseAndWait,
  releaseUntil,
  runChild,
  seedRecord,
  shapeOf,
  startWriterHeldMidLine,
  submitThroughRealOwner,
  waitFor,
  withTempHome,
} from "./stream-appender-kit.js";

// brick 3f33cc2d (the eef0805f TE's F1): every lockless appender to `<id>.stream.ndjson` goes through ONE
// line-boundary rule. These rows drive the PRODUCTION entry points and REAL processes (a writer held
// between parts by the existing `ACPX_TEST_STREAM_HOLD_MID_LINE` seam), so they also run on 57004dd5 +
// the seam commit, where the dead-writer, live-writer and queue rows are red.

const TASK = { messageId: "msg-1", requestId: "req-1" };
const FAILED = { code: 1, message: "boom", detailCode: "BOOM" };
const LONG_STALL = { ACPX_TEST_STREAM_APPEND_STALL_MS: "60000" };

function setEnv(values: Record<string, string>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function deliveryPhases(events: AcpJsonRpcMessage[], messageId: string): string[] {
  return events
    .filter((event) => (event as { method?: string }).method === DELIVERY_EVENT_METHOD)
    .map((event) => (event as { params: { messageId?: string; phase: string } }).params)
    .filter((params) => params.messageId === messageId)
    .map((params) => params.phase);
}

/** The appender sites reachable without a real owner, each as the production call and a check that its line is readable. */
const SITES: {
  name: string;
  append: (id: string) => Promise<void>;
  present: (events: AcpJsonRpcMessage[]) => boolean;
}[] = [
  {
    name: "ipc-server:253 appendDeliveryStreamEvent (queued, async)",
    append: async (id) => {
      appendDeliveryStreamEvent(id, TASK, "queued");
      await waitFor("the queued line", () =>
        fs.readFileSync(sessionEventActivePath(id), "utf8").includes('"queued"'),
      );
    },
    present: (events) => deliveryPhases(events, TASK.messageId).includes("queued"),
  },
  {
    name: "ipc-server:284 appendDeliveryStreamEventSync (done)",
    append: async (id) => {
      appendDeliveryStreamEventSync(id, TASK, "done", undefined, { stopReason: "end_turn" });
    },
    present: (events) => hasCompletedDeliveryFor(events, TASK.messageId),
  },
  {
    name: "ipc-server:284 appendDeliveryStreamEventSync (failed)",
    append: async (id) => {
      appendDeliveryStreamEventSync(id, TASK, "failed", FAILED);
    },
    present: (events) => deliveryPhases(events, TASK.messageId).includes("failed"),
  },
  {
    name: "ipc-server:284 appendDeliveryStreamEventSync (cancelled)",
    append: async (id) => {
      appendDeliveryStreamEventSync(id, TASK, "cancelled", FAILED);
    },
    present: (events) => deliveryPhases(events, TASK.messageId).includes("cancelled"),
  },
  {
    name: "ipc-server:325 appendRefusedStreamEventSync (acpx/refused)",
    append: async (id) => {
      appendRefusedStreamEventSync(id, { requestId: "req-refused" }, FAILED);
    },
    present: (events) => methodsOf(events).includes("acpx/refused"),
  },
  {
    name: "owner-task-reap:177 appendClearedBackgroundTasksLine (_claude/backgroundTasks)",
    append: async (id) => {
      await appendClearedBackgroundTasksLine(id, "acp-1");
    },
    present: (events) => methodsOf(events).includes("_claude/backgroundTasks"),
  },
];

for (const site of SITES) {
  test(`A DEAD writer's partial line, then ${site.name}: the line is read, exactly ONE line is damaged`, async (t) => {
    if (process.platform !== "linux") {
      t.skip("the stream lock's holder judging needs linux process identity");
      return;
    }
    await withTempHome("acpx-appender-dead-", async (homeDir) => {
      const id = "dead-writer";
      await leaveDeadWriterMidLine(homeDir, id);
      const before = await fsp.readFile(sessionEventActivePath(id));
      assert.notEqual(before.at(-1), 0x0a, "the dead writer's tail is a PARTIAL line");

      await site.append(id);

      const shape = shapeOf(await fsp.readFile(sessionEventActivePath(id), "utf8"));
      const events = await listSessionEvents(id);
      assert.equal(site.present(events), true, "the appender's line survived the partial tail");
      assert.deepEqual(
        frameNumbers(events),
        [1],
        "frame 1, the dead writer's whole line, is intact",
      );
      assert.equal(
        shape.damaged,
        1,
        "exactly ONE line is damaged: the dead writer's partial frame 2",
      );
      assert.equal(shape.empty, 0, "no empty line");
    });
  });
}

test("A DEAD writer, then a `done` terminal: the duplicate-delivery guard still sees it (hasCompletedDeliveryFor)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-dedup-", async (homeDir) => {
    const id = "dead-writer-done";
    await leaveDeadWriterMidLine(homeDir, id);
    appendDeliveryStreamEventSync(id, TASK, "done", undefined, { stopReason: "end_turn" });
    assert.equal(
      hasCompletedDeliveryFor(await listSessionEvents(id), TASK.messageId),
      true,
      "a duplicate --message-id re-send after the dead writer is still deduplicated",
    );
  });
});

test("A DEAD writer, then the REAL owner's `acpx/received` marker (the dominant production order)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-received-", async (homeDir) => {
    const id = "dead-writer-received";
    await leaveDeadWriterMidLine(homeDir, id);
    await submitThroughRealOwner(id, "req-received", "msg-received", async () => {
      await waitFor("the received marker", () =>
        fs.readFileSync(sessionEventActivePath(id), "utf8").includes("acpx/received"),
      );
    });
    const events = await listSessionEvents(id);
    assert.ok(methodsOf(events).includes("acpx/received"), "the marker is READ");
    const shape = shapeOf(await fsp.readFile(sessionEventActivePath(id), "utf8"));
    assert.equal(shape.damaged, 1);
    assert.equal(shape.empty, 0);
  });
});

test("A LIVE writer between parts, then the REAL owner's marker: nothing lands in the live line; it is written after the line completes (no empty line)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-live-", async (homeDir) => {
    const restore = setEnv(LONG_STALL);
    try {
      const id = "live-writer-received";
      await seedRecord(homeDir, id);
      const held = await startWriterHeldMidLine(homeDir, id);
      const active = sessionEventActivePath(id);
      const before = fs.statSync(active).size;
      await submitThroughRealOwner(id, "req-live", "msg-live", async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(
          fs.statSync(active).size,
          before,
          "the marker waits: not one byte was written into the LIVE writer's partial line",
        );
        await releaseAndWait(held);
        await waitFor("the marker after the live line", () =>
          fs.readFileSync(active, "utf8").includes("acpx/received"),
        );
      });
      const shape = shapeOf(await fsp.readFile(active, "utf8"));
      assert.deepEqual(
        { damaged: shape.damaged, empty: shape.empty },
        { damaged: 0, empty: 0 },
        "the live frame is whole, the marker is a line of its own, no empty line",
      );
      const events = await listSessionEvents(id);
      assert.deepEqual(frameNumbers(events), [1, 2]);
      assert.ok(methodsOf(events).includes("acpx/received"));
    } finally {
      restore();
    }
  });
});

const SYNC_APPENDER = `
import fs from "node:fs";
const [ipcUrl, id, goFile] = process.argv.slice(1);
const ipc = await import(ipcUrl);
if (goFile) fs.writeFileSync(goFile, "go");
const startedAt = Date.now();
ipc.appendDeliveryStreamEventSync(id, { messageId: "msg-sync", requestId: "req-sync" }, "done", undefined, { stopReason: "end_turn" });
process.stdout.write(String(Date.now() - startedAt));
`;
const IPC_SERVER_URL = new URL("../src/cli/queue/ipc-server.js", import.meta.url).href;

test("A LIVE writer between parts, then a SYNC `done` terminal in another process: it waits, then lands after the whole line", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-live-sync-", async (homeDir) => {
    const id = "live-writer-sync";
    await seedRecord(homeDir, id);
    const held = await startWriterHeldMidLine(homeDir, id);
    const active = sessionEventActivePath(id);
    const before = fs.statSync(active).size;
    const goFile = path.join(homeDir, "appender-go");
    const appender = runChild(SYNC_APPENDER, [IPC_SERVER_URL, id, goFile], {
      ...process.env,
      NODE_TEST_CONTEXT: "child-v8",
      ...LONG_STALL,
    });
    await waitFor("the sync appender to reach its call", () => fs.existsSync(goFile));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      fs.statSync(active).size,
      before,
      "the sync appender writes nothing into the live line",
    );
    await releaseAndWait(held);
    const result = await appender;
    assert.equal(result.code, 0);
    assert.ok(Number(result.stdout) >= 450, `it waited (${result.stdout} ms)`);
    const shape = shapeOf(await fsp.readFile(active, "utf8"));
    assert.deepEqual({ damaged: shape.damaged, empty: shape.empty }, { damaged: 0, empty: 0 });
    const events = await listSessionEvents(id);
    assert.deepEqual(frameNumbers(events), [1, 2]);
    assert.equal(hasCompletedDeliveryFor(events, "msg-sync"), true);
  });
});

test("A FROZEN live holder (async): the appender waits the 5 s stall time, then closes the line and writes ONE marker", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-stall-async-", async (homeDir) => {
    const id = "frozen-async";
    await seedRecord(homeDir, id);
    const held = await startWriterHeldMidLine(homeDir, id);
    const active = sessionEventActivePath(id);
    const startedAt = Date.now();
    appendDeliveryStreamEvent(id, TASK, "queued");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.equal(
      fs.readFileSync(active, "utf8").includes('"queued"'),
      false,
      "nothing is written before the stall time",
    );
    await waitFor(
      "the marker after the stall",
      () => fs.readFileSync(active, "utf8").includes('"queued"'),
      10_000,
    );
    const waited = Date.now() - startedAt;
    assert.ok(
      waited >= 4_900 && waited < 9_000,
      `written at the 5 s stall, not before (${waited} ms)`,
    );
    await killAndWait(held);
    const payload = await fsp.readFile(active, "utf8");
    assert.equal(payload.split('"queued"').length - 1, 1, "ONE marker line");
    const shape = shapeOf(payload);
    assert.deepEqual({ damaged: shape.damaged, empty: shape.empty }, { damaged: 1, empty: 0 });
  });
});

test("A FROZEN live holder (sync): the whole wait is capped at 1 s, then ONE terminal is written", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-stall-sync-", async (homeDir) => {
    const id = "frozen-sync";
    await seedRecord(homeDir, id);
    const held = await startWriterHeldMidLine(homeDir, id);
    // No NODE_TEST_CONTEXT and no override: the REAL constant.
    const result = await runChild(
      SYNC_APPENDER,
      [IPC_SERVER_URL, id],
      envWithout("NODE_TEST_CONTEXT", "ACPX_TEST_STREAM_APPEND_STALL_MS"),
    );
    assert.equal(result.code, 0);
    const elapsed = Number(result.stdout);
    assert.ok(
      elapsed >= 1_000 && elapsed < 1_400,
      `the sync wait ends at its 1 s cap, inside PROCESS_EXIT_GRACE_MS (1500 ms): ${elapsed} ms`,
    );
    await killAndWait(held);
    const payload = await fsp.readFile(sessionEventActivePath(id), "utf8");
    assert.equal(payload.split('"done"').length - 1, 1, "ONE terminal line");
    assert.equal(hasCompletedDeliveryFor(await listSessionEvents(id), "msg-sync"), true);
  });
});

test("An UNJUDGEABLE holder takes the wait path, a dead one does not", async () => {
  await withTempHome("acpx-appender-unjudgeable-", async (homeDir) => {
    const restore = setEnv({ ACPX_TEST_STREAM_APPEND_STALL_MS: "700" });
    try {
      const id = "unjudgeable";
      await seedRecord(homeDir, id);
      const active = sessionEventActivePath(id);
      // A partial tail and a lock whose holder this process cannot judge: a legacy body (a pid, no birth identity) of a LIVE pid.
      await fsp.writeFile(active, `${JSON.stringify(frame(1))}\n{"jsonrpc":"2.0","meth`);
      await fsp.writeFile(
        path.join(path.dirname(active), "unjudgeable.stream.lock"),
        JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }),
      );
      appendDeliveryStreamEvent(id, TASK, "queued");
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(
        fs.readFileSync(active, "utf8").includes('"queued"'),
        false,
        "not proven dead: the appender waits",
      );
      await waitFor("the marker after the stall", () =>
        fs.readFileSync(active, "utf8").includes('"queued"'),
      );
      assert.equal(shapeOf(fs.readFileSync(active, "utf8")).damaged, 1);
    } finally {
      restore();
    }
  });
});

test("(a) A line queued behind THIS process's own multi-part write goes out after the last part, whole, in call order", async () => {
  await withTempHome("acpx-appender-queue-", async (homeDir) => {
    const id = "own-parts";
    await seedRecord(homeDir, id);
    const marker = path.join(homeDir, "own-hold");
    const restore = setEnv({ ACPX_TEST_STREAM_HOLD_MID_LINE: marker });
    try {
      const writer = await SessionEventWriter.open(await resolveSessionRecord(id));
      const active = sessionEventActivePath(id);
      const flush = writer.appendMessages([frame(1), frame(2, 2.5 * 1024 * 1024)]);
      await waitFor("the writer between parts", () => fs.existsSync(marker));
      const before = fs.statSync(active).size;
      appendDeliveryStreamEventSync(id, TASK, "done", undefined, { stopReason: "end_turn" });
      appendDeliveryStreamEvent(id, { messageId: "msg-2", requestId: "req-2" }, "queued");
      appendRefusedStreamEventSync(id, { requestId: "req-3" }, FAILED);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.statSync(active).size, before, "nothing is written between the parts");
      await releaseUntil(marker, flush);
      await writer.close({ checkpoint: false });
      const payload = await fsp.readFile(active, "utf8");
      const shape = shapeOf(payload);
      assert.deepEqual({ damaged: shape.damaged, empty: shape.empty }, { damaged: 0, empty: 0 });
      const events = await listSessionEvents(id);
      assert.deepEqual(frameNumbers(events), [1, 2], "the big frame is whole");
      assert.deepEqual(
        methodsOf(events).slice(-3),
        [DELIVERY_EVENT_METHOD, DELIVERY_EVENT_METHOD, "acpx/refused"],
        "the three queued lines follow it, in call order",
      );
    } finally {
      restore();
    }
  });
});

test("(a) A line queued behind a multi-part write that THROWS is written with the closing newline of the line that will never finish", async () => {
  await withTempHome("acpx-appender-queue-throw-", async (homeDir) => {
    const id = "own-parts-throw";
    await seedRecord(homeDir, id);
    const marker = path.join(homeDir, "own-hold-throw");
    const restore = setEnv({ ACPX_TEST_STREAM_HOLD_MID_LINE: marker });
    const realOpen = fsp.open.bind(fsp);
    mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (!String(args[0]).endsWith(".stream.ndjson") || args[1] !== "a") {
        return handle;
      }
      let writes = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "write") {
            return async (...writeArgs: Parameters<typeof handle.write>) => {
              writes += 1;
              if (writes === 2) {
                throw new Error("injected part failure");
              }
              return await (target.write as (...a: unknown[]) => Promise<unknown>)(...writeArgs);
            };
          }
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      const writer = await SessionEventWriter.open(await resolveSessionRecord(id));
      const flush = writer.appendMessages([frame(1, 2.5 * 1024 * 1024)]);
      const rejected = assert.rejects(flush, /injected part failure/);
      await waitFor("the writer between parts", () => fs.existsSync(marker));
      appendDeliveryStreamEventSync(id, TASK, "done", undefined, { stopReason: "end_turn" });
      fs.rmSync(marker);
      await rejected;
      const shape = shapeOf(await fsp.readFile(sessionEventActivePath(id), "utf8"));
      assert.deepEqual({ damaged: shape.damaged, empty: shape.empty }, { damaged: 1, empty: 0 });
      assert.equal(hasCompletedDeliveryFor(await listSessionEvents(id), TASK.messageId), true);
    } finally {
      mock.restoreAll();
      restore();
    }
  });
});

const EXIT_CHILD = `
import fs from "node:fs";
const [eventsUrl, persistenceUrl, ipcUrl, id, marker] = process.argv.slice(1);
const events = await import(eventsUrl);
const persistence = await import(persistenceUrl);
const ipc = await import(ipcUrl);
const writer = await events.SessionEventWriter.open(await persistence.resolveSessionRecord(id));
void writer.appendMessages([{ jsonrpc: "2.0", method: "session/update", params: { n: 2, pad: "x".repeat(2.5 * 1024 * 1024) } }]);
while (!fs.existsSync(marker)) await new Promise((r) => setTimeout(r, 20));
ipc.appendDeliveryStreamEventSync(id, { messageId: "msg-exit", requestId: "req-exit" }, "done", undefined, { stopReason: "end_turn" });
process.exit(0);
`;

test("(a) A line queued behind this process's multi-part write when the process EXITS is written with the closing newline", async () => {
  await withTempHome("acpx-appender-queue-exit-", async (homeDir) => {
    const id = "own-parts-exit";
    await seedRecord(homeDir, id);
    const marker = path.join(homeDir, "exit-hold");
    const result = await runChild(
      EXIT_CHILD,
      [
        new URL("../src/session/events.js", import.meta.url).href,
        new URL("../src/session/persistence.js", import.meta.url).href,
        IPC_SERVER_URL,
        id,
        marker,
      ],
      { ...process.env, NODE_TEST_CONTEXT: "child-v8", ACPX_TEST_STREAM_HOLD_MID_LINE: marker },
    );
    assert.equal(result.code, 0);
    const shape = shapeOf(await fsp.readFile(sessionEventActivePath(id), "utf8"));
    assert.deepEqual({ damaged: shape.damaged, empty: shape.empty }, { damaged: 1, empty: 0 });
    assert.equal(hasCompletedDeliveryFor(await listSessionEvents(id), "msg-exit"), true);
  });
});

test("(d) SessionEventWriter.open closes a dead writer's tail ONCE, at acquisition; the first append then adds nothing", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-open-close-", async (homeDir) => {
    const id = "open-close";
    await leaveDeadWriterMidLine(homeDir, id);
    const active = sessionEventActivePath(id);
    const dead = await fsp.readFile(active);
    const writer = await SessionEventWriter.open(await resolveSessionRecord(id));
    const opened = await fsp.readFile(active);
    assert.deepEqual(
      opened,
      Buffer.concat([dead, Buffer.from("\n")]),
      "open added exactly one newline",
    );
    await writer.appendMessages([frame(3)]);
    await writer.close({ checkpoint: false });
    const after = await fsp.readFile(active);
    assert.deepEqual(
      after,
      Buffer.concat([opened, Buffer.from(`${JSON.stringify(frame(3))}\n`)]),
      "the first append added its own line only",
    );
  });
});

test("NEGATIVES: a clean tail, an empty file and a missing file get exactly the appender's bytes — no newline, no empty line", async () => {
  await withTempHome("acpx-appender-negative-", async (homeDir) => {
    await seedRecord(homeDir, "neg");
    const active = sessionEventActivePath("neg");
    const done = (): void =>
      appendDeliveryStreamEventSync("neg", TASK, "done", undefined, { stopReason: "end_turn" });

    done(); // missing file
    const stamp = (text: string): string => text.replace(/"at":"[^"]*"/g, '"at":"T"');
    const first = stamp(await fsp.readFile(active, "utf8"));
    assert.deepEqual(shapeOf(first), { lines: 1, empty: 0, damaged: 0, endsWithNewline: true });

    await fsp.writeFile(active, ""); // empty file
    done();
    assert.equal(stamp(await fsp.readFile(active, "utf8")), first);

    await fsp.writeFile(active, `${JSON.stringify(frame(1))}\n`); // clean tail
    done();
    assert.equal(
      stamp(await fsp.readFile(active, "utf8")),
      `${JSON.stringify(frame(1))}\n${first}`,
    );
  });
});

test("Two appenders in a row after a dead writer put ONE closing newline between them, not two", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the stream lock's holder judging needs linux process identity");
    return;
  }
  await withTempHome("acpx-appender-twice-", async (homeDir) => {
    const id = "twice";
    await leaveDeadWriterMidLine(homeDir, id);
    appendDeliveryStreamEventSync(id, TASK, "failed", FAILED);
    appendRefusedStreamEventSync(id, { requestId: "req-refused" }, FAILED);
    const shape = shapeOf(await fsp.readFile(sessionEventActivePath(id), "utf8"));
    assert.deepEqual(
      { damaged: shape.damaged, empty: shape.empty, lines: shape.lines },
      { damaged: 1, empty: 0, lines: 4 },
    );
  });
});
