import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket, nextJsonLine } from "./queue-test-helpers.js";

// ---------------------------------------------------------------------------
// D1 / A6 — the SIGNAL PATH (brick://53437107), acpx gates L1.5 and L1.6.
//
// THIS IS THE GATE THAT CATCHES THE async-appendFile TRAP. L1.1 passes with the
// old asynchronous writer: the drain verb returns a correct report and the
// in-memory state is right. Only a REAL process, a REAL SIGTERM, and an
// assertion on the FILE catches the fact that an async append never flushes
// before `process.exit()` — which is why every externally-killed owner lost its
// custody in silence. Skipping this ships a drain that works for the verb we
// added and keeps losing everything on every other kill.
//
// The `--async-writer` control below is what stops this gate from being
// vacuous: the identical process, killed identically, writing through the OLD
// asynchronous writer, must produce NO terminal on disk.
// ---------------------------------------------------------------------------

// L1.6 bound. PROCESS_EXIT_GRACE_MS is 1_500 ms — the whole window before
// SIGKILL — so the handler has to finish in a small fraction of it. A regression
// here means the owner no longer dies on SIGTERM and only the SIGKILL saves it,
// i.e. process teardown made worse fleet-wide (risk R1).
const SIGNAL_EXIT_LATENCY_BUDGET_MS = 300;
const PINNED_TASK_COUNT = 20;

const OWNER_HARNESS = `
import { spawn } from "node:child_process";
import { installQueueOwnerFatalSignalHandlers } from "%RUNTIME%";
import {
  appendDeliveryStreamEvent,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "%IPC%";

const sessionId = process.argv[2];
const asyncWriterControl = process.argv[3] === "--async-writer";

// A long-lived descendant in this process's group, standing in for the ACP
// adapter and its SDK children — the processes that were being stranded.
const adapterChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
process.stdout.write("CHILD " + adapterChild.pid + "\\n");
const lease = await tryAcquireQueueOwnerLease(sessionId);
if (!lease) {
  process.stderr.write("harness: could not acquire lease\\n");
  process.exit(9);
}
const owner = await SessionQueueOwner.start(
  lease,
  {
    cancelPrompt: async () => false,
    closeSession: async () => true,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    queryActiveTurn: () => false,
  },
  { maxQueueDepth: 64 },
);

if (asyncWriterControl) {
  // CONTROL — the pre-fix behaviour, on the identical signal path: hand the
  // write to libuv and exit. Nothing reaches disk. This is what makes the real
  // gate below meaningful rather than decorative.
  process.on("SIGTERM", () => {
    for (let index = 0; index < 3; index += 1) {
      appendDeliveryStreamEvent(
        sessionId,
        { messageId: "msg-" + index, requestId: "req-" + index },
        "failed",
        { code: 0, message: "control: asynchronous writer", detailCode: "QUEUE_OWNER_SHUTDOWN" },
      );
    }
    process.exit(143);
  });
} else {
  installQueueOwnerFatalSignalHandlers({ sessionId, owner });
}

process.stdout.write("READY " + lease.socketPath + "\\n");
setInterval(() => {}, 1000);
`;

type OwnerHarness = {
  child: ReturnType<typeof spawn>;
  socketPath: string;
  adapterChildPid: number;
};

async function startOwnerHarness(options: {
  homeDir: string;
  scriptPath: string;
  sessionId: string;
  asyncWriterControl?: boolean;
  // `detached: true` makes the harness its own process-group LEADER, which is how
  // the real queue owner is spawned (queue-owner-process.ts). Left false, the
  // harness shares the test runner's group and is deliberately NOT a leader —
  // that is the guard case.
  groupLeader?: boolean;
}): Promise<OwnerHarness> {
  const child = spawn(
    process.execPath,
    [
      options.scriptPath,
      options.sessionId,
      ...(options.asyncWriterControl ? ["--async-writer"] : []),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: options.homeDir },
      detached: options.groupLeader === true,
    },
  );
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let adapterChildPid = 0;
  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (line.startsWith("CHILD ")) {
      adapterChildPid = Number(line.slice("CHILD ".length).trim());
      continue;
    }
    if (line.startsWith("READY ")) {
      lines.close();
      return { child, socketPath: line.slice("READY ".length).trim(), adapterChildPid };
    }
  }
  throw new Error(`owner harness never became ready: ${stderr}`);
}

// Every harness now spawns an adapter stand-in. Any test whose owner does NOT
// reap its own group must clean that child up itself, or this suite becomes the
// orphan problem it exists to prevent.
function killAdapterChild(harness: OwnerHarness): void {
  if (!Number.isInteger(harness.adapterChildPid) || harness.adapterChildPid <= 0) {
    return;
  }
  try {
    process.kill(harness.adapterChildPid, "SIGKILL");
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The reap is asynchronous from this process's point of view: the SIGKILL lands
// on the group, then the kernel reaps its members. Poll on the OBSERVABLE (the
// pid is gone), never on a fixed sleep.
async function waitForPidGone(pid: number, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

// PIN CUSTODY — real submissions over the real socket that the harness never
// pulls (it never calls `nextTask`), so they provably sit in `pending` until a
// signal sweeps them. Custody is a state, not a window; no clock is involved.
async function pinTasksInHarness(socketPath: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const socket = await connectSocket(socketPath);
    const lines = readline.createInterface({ input: socket });
    const iterator = lines[Symbol.asyncIterator]();
    socket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId: `req-${index}`,
        messageId: `msg-${index}`,
        message: `pinned ${index}`,
        permissionMode: "approve-all",
        waitForCompletion: false,
      })}\n`,
    );
    const frame = (await nextJsonLine(iterator)) as { type: string };
    assert.equal(frame.type, "accepted");
    lines.close();
    socket.destroy();
  }
}

async function readDeliveryTerminals(
  sessionId: string,
  homeDir: string,
): Promise<Array<{ messageId: string; phase: string; error?: { detailCode: string } }>> {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const streamPath = sessionEventActivePath(sessionId);
  if (previousHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  const payload = await fs.readFile(streamPath, "utf8").catch(() => "");
  return payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
    .filter((event) => event.method === "acpx/delivery")
    .map(
      (event) =>
        event.params as { messageId: string; phase: string; error?: { detailCode: string } },
    );
}

async function withSignalHarnessHome(
  run: (context: { homeDir: string; scriptPath: string }) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-drain-signal-"));
  try {
    const scriptPath = path.join(homeDir, "owner-harness.mjs");
    await fs.writeFile(
      scriptPath,
      OWNER_HARNESS.replace(
        "%RUNTIME%",
        new URL("../src/cli/session/queue-owner-runtime.js", import.meta.url).href,
      ).replace("%IPC%", new URL("../src/cli/queue/ipc.js", import.meta.url).href),
      "utf8",
    );
    await run({ homeDir, scriptPath });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function prepareSessionStreamDir(sessionId: string, homeDir: string): Promise<void> {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const streamPath = sessionEventActivePath(sessionId);
  if (previousHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  await fs.mkdir(path.dirname(streamPath), { recursive: true });
}

// L1.5 + L1.6 — a real owner process, a real SIGTERM, an assertion on the file,
// and a measured exit latency.
test("L1.5/L1.6 a real SIGTERM writes pending custody terminals to disk, inside the grace window", async () => {
  await withSignalHarnessHome(async ({ homeDir, scriptPath }) => {
    const sessionId = "signal-sync-writer";
    await prepareSessionStreamDir(sessionId, homeDir);
    const harness = await startOwnerHarness({ homeDir, scriptPath, sessionId });

    try {
      await pinTasksInHarness(harness.socketPath, PINNED_TASK_COUNT);

      const killedAt = Date.now();
      // Two signals back to back: the handler must be re-entrant, i.e. the
      // second must exit immediately rather than queue behind the first, and it
      // must never produce a second terminal for the same message.
      harness.child.kill("SIGTERM");
      harness.child.kill("SIGTERM");
      const [code, signal] = (await once(harness.child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      const exitLatencyMs = Date.now() - killedAt;

      assert.equal(signal, null, "the owner must handle SIGTERM, not die from it");
      assert.equal(code, 143, "conventional 128 + SIGTERM");
      assert.ok(
        exitLatencyMs <= SIGNAL_EXIT_LATENCY_BUDGET_MS,
        `signal exit took ${exitLatencyMs}ms with ${PINNED_TASK_COUNT} pinned items; ` +
          `budget is ${SIGNAL_EXIT_LATENCY_BUDGET_MS}ms inside PROCESS_EXIT_GRACE_MS=1500`,
      );

      const terminals = await readDeliveryTerminals(sessionId, homeDir);
      assert.equal(
        terminals.length,
        PINNED_TASK_COUNT,
        "every pinned message must carry an owner-written terminal ON DISK",
      );
      assert.equal(new Set(terminals.map((entry) => entry.messageId)).size, PINNED_TASK_COUNT);
      for (const terminal of terminals) {
        assert.equal(terminal.phase, "failed");
        // An external kill leaves the session OPEN, so the honest code is the
        // retryable one — acpx-ui re-drives it (KD-3).
        assert.equal(terminal.error?.detailCode, "QUEUE_OWNER_SHUTDOWN");
      }
    } finally {
      harness.child.kill("SIGKILL");
      killAdapterChild(harness);
    }
  });
});

// DELTA 2(a) — the orphan-reap gate. A signal-killed owner must not strand its
// adapter descendants. Before this handler existed, the reap ran ONLY on the
// graceful path and only if it beat the 1.5 s SIGKILL, so an externally-killed
// owner left its whole subtree behind. On a shared box that is how load reaches
// 40+ (this lane stranded 26 such processes in one afternoon).
//
// The assertion is on the OUTCOME — custody durable AND no surviving group — not
// on how the handler achieves it.
test("Delta2a a group-leading owner reaps its adapter descendants on SIGTERM, after writing custody", async () => {
  await withSignalHarnessHome(async ({ homeDir, scriptPath }) => {
    const sessionId = "signal-group-reap";
    await prepareSessionStreamDir(sessionId, homeDir);
    const harness = await startOwnerHarness({
      homeDir,
      scriptPath,
      sessionId,
      groupLeader: true,
    });

    try {
      assert.ok(harness.adapterChildPid > 0, "harness must report its adapter child pid");
      assert.ok(isAlive(harness.adapterChildPid), "the adapter child starts alive");
      await pinTasksInHarness(harness.socketPath, 3);

      harness.child.kill("SIGTERM");
      await once(harness.child, "exit");

      // (i) Custody is durable — and this is the run where the reap SIGKILLs the
      // handler mid-flight, so it proves the sweep completes BEFORE the reap.
      // If a refactor ever moved the sweep below the reap, this goes red.
      const terminals = await readDeliveryTerminals(sessionId, homeDir);
      assert.equal(terminals.length, 3, "custody must be on disk even though the reap kills us");
      for (const terminal of terminals) {
        assert.equal(terminal.error?.detailCode, "QUEUE_OWNER_SHUTDOWN");
      }

      // (ii) No orphan survives.
      assert.ok(
        await waitForPidGone(harness.adapterChildPid),
        `adapter child ${harness.adapterChildPid} survived the owner's death — orphan reap regressed`,
      );
    } finally {
      harness.child.kill("SIGKILL");
      killAdapterChild(harness);
    }
  });
});

// The NON-LEADER branch, which nothing else exercises: an owner embedded in
// someone else's process group must not sweep it, and must still die.
//
// HONEST LIMIT OF THIS GATE: it asserts the OUTCOME (no collateral kill, owner
// dies, custody durable) and cannot isolate WHICH protection produced it. Two
// independent ones apply — `ownerIsGroupLeader()` is false, and
// `hasLiveProcessGroup(process.pid)` is also false because no process group
// carries this pid — so removing the leader guard alone would not turn this red.
// That belt-and-braces is why a broken guard cannot take down the test runner's
// own group, which is the failure mode worth being defensive about.
test("Delta2a a NON-leader owner never sweeps the group it is embedded in, and still exits", async () => {
  await withSignalHarnessHome(async ({ homeDir, scriptPath }) => {
    const sessionId = "signal-non-leader";
    await prepareSessionStreamDir(sessionId, homeDir);
    // groupLeader omitted → the harness shares this test runner's process group.
    const harness = await startOwnerHarness({ homeDir, scriptPath, sessionId });

    try {
      assert.ok(isAlive(harness.adapterChildPid), "the adapter child starts alive");
      await pinTasksInHarness(harness.socketPath, 2);

      harness.child.kill("SIGTERM");
      const [code] = (await once(harness.child, "exit")) as [number | null, NodeJS.Signals | null];

      // R1 still holds on this branch: no group to reap, so it exits explicitly.
      assert.equal(code, 143, "a non-leader owner must still die on SIGTERM");

      // Custody is still durable.
      assert.equal((await readDeliveryTerminals(sessionId, homeDir)).length, 2);

      // And it did NOT sweep. The child shares OUR group; killing that group
      // would have taken down the test runner itself, so its survival is the
      // proof the leader guard held.
      assert.ok(
        isAlive(harness.adapterChildPid),
        "a non-leader owner must not reap a process group it does not own",
      );
    } finally {
      harness.child.kill("SIGKILL");
      killAdapterChild(harness);
    }
  });
});

// THE CONTROL for L1.5. Identical process, identical signal, identical pinned
// custody — but written through the OLD asynchronous writer. Nothing reaches
// disk, because `process.exit()` runs before libuv ever dispatches the append.
// If this ever goes green, L1.5 above is no longer proving anything.
test("L1.5 control: the asynchronous writer loses every terminal on the same signal path", async () => {
  await withSignalHarnessHome(async ({ homeDir, scriptPath }) => {
    const sessionId = "signal-async-control";
    await prepareSessionStreamDir(sessionId, homeDir);
    const harness = await startOwnerHarness({
      homeDir,
      scriptPath,
      sessionId,
      asyncWriterControl: true,
    });

    try {
      await pinTasksInHarness(harness.socketPath, 3);
      harness.child.kill("SIGTERM");
      await once(harness.child, "exit");

      assert.deepEqual(
        await readDeliveryTerminals(sessionId, homeDir),
        [],
        "an async append does not survive process.exit() — this is the trap L1.5 exists to catch",
      );
    } finally {
      harness.child.kill("SIGKILL");
      killAdapterChild(harness);
    }
  });
});
