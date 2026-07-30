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
import { installQueueOwnerFatalSignalHandlers } from "%RUNTIME%";
import {
  appendDeliveryStreamEvent,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "%IPC%";

const sessionId = process.argv[2];
const asyncWriterControl = process.argv[3] === "--async-writer";
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
};

async function startOwnerHarness(options: {
  homeDir: string;
  scriptPath: string;
  sessionId: string;
  asyncWriterControl?: boolean;
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
    },
  );
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (line.startsWith("READY ")) {
      lines.close();
      return { child, socketPath: line.slice("READY ".length).trim() };
    }
  }
  throw new Error(`owner harness never became ready: ${stderr}`);
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
    }
  });
});
