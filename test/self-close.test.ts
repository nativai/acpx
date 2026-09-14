// brick://f4f1fa54 — SELF-CLOSE. A session closed BY ITSELF must still end
// `closed: true`: the CLI process performing the close is a descendant of the
// very queue owner the close terminates (owner → adapter → agent → this CLI),
// and the pre-fix order (drain → ACP shutdown → terminate owner → THEN write
// `closed: true`) killed the caller's own tree before the write ever landed.
// Observed live: a session that self-closed stayed `closed:false`.
//
// The ancestry detector rows are unit rows against REAL processes. The
// self-close row is a REAL three-process rig, not a spy: an intermediate
// "owner" (which, like the production queue owner, kills its child on exit)
// spawns the close-running grandchild, and the test asserts that the terminal
// record lands on disk EVEN THOUGH the owner kill genuinely fired. Under the
// pre-fix order this row is RED — the cascade kills the grandchild before any
// write — so it is a differential proof of the ordering, not a tautology.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import {
  closeSession,
  isPidSelfOrAncestor,
  readSelfAncestorPids,
} from "../src/cli/session/session-control.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import {
  closeServer,
  listenServer,
  queuePaths,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const CHILD_PATH = fileURLToPath(new URL("./self-close-owner-child.js", import.meta.url));

async function spawnKeeper(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  return child;
}

// ---------------------------------------------------------------------------
// (a) the ancestry detector — self pid / direct ancestor / unrelated pid.
// Real processes, not mocks: the walk is only as good as its /proc parsing.
// ---------------------------------------------------------------------------

test("isPidSelfOrAncestor: the process's own pid is a self-close", async () => {
  assert.equal(await isPidSelfOrAncestor(process.pid), true);
});

test("isPidSelfOrAncestor: the direct parent is an ancestor", async () => {
  if (process.ppid <= 1) {
    // Orphaned runner — the direct-parent check cannot be exercised here.
    return;
  }
  assert.equal(await isPidSelfOrAncestor(process.ppid), true);
});

test("isPidSelfOrAncestor: a spawned child is not an ancestor, and the walk finds this process ABOVE a child", async () => {
  const child = await spawnKeeper();
  try {
    // A descendant is never an ancestor — negative for the exact pid we hold.
    assert.equal(child.pid !== undefined && (await isPidSelfOrAncestor(child.pid)), false);

    // Positive control for the WALK itself: starting from the real child, the
    // chain must pass through this process. Proves the detector could have
    // seen an ancestor had one been planted (norm-1 positive control).
    const ancestorsOfChild = await readSelfAncestorPids(child.pid);
    assert.equal(
      ancestorsOfChild.includes(process.pid),
      true,
      "the PPid walk from a real child must pass through this process",
    );
  } finally {
    child.kill("SIGKILL");
  }
});

test("isPidSelfOrAncestor: rejects non-positive pids", async () => {
  assert.equal(await isPidSelfOrAncestor(0), false);
  assert.equal(await isPidSelfOrAncestor(-5), false);
});

// ---------------------------------------------------------------------------
// Shared rig helpers.
// ---------------------------------------------------------------------------

async function seedSessionRecord(homeDir: string, sessionId: string): Promise<void> {
  const record = makeSessionRecord({
    acpxRecordId: sessionId,
    acpSessionId: `${sessionId}-acp`,
    agentCommand: "agent",
    cwd: homeDir,
  });
  const filePath = path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(sessionId)}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

type ObservedRequest = { type: string };

// A recording owner socket. The self arm must NEVER connect to it; the
// non-self path hits it with the exact drain → close_session sequence.
function createRecordingOwnerServer(observed: ObservedRequest[]): net.Server {
  return net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => {
      // a close racing the socket is normal here
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const request = JSON.parse(line) as { requestId: string; type: string };
        observed.push({ type: request.type });
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        if (request.type === "drain_deliveries") {
          socket.write(
            `${JSON.stringify({
              type: "drain_deliveries_result",
              requestId: request.requestId,
              drained: 0,
              undelivered: [],
              turnSettled: true,
              activeTurnAtEntry: false,
            })}\n`,
          );
        } else if (request.type === "close_session") {
          socket.write(
            `${JSON.stringify({
              type: "close_session_result",
              requestId: request.requestId,
              closed: true,
            })}\n`,
          );
        }
        socket.end();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// (b) the self-close row — the terminal record lands closed:true even though
// the owner kill fires against a REAL ancestor of the closing process.
// ---------------------------------------------------------------------------

// The intermediate "owner": spawns the close-running grandchild, and on
// SIGTERM kills that child before exiting — faithfully modelling the
// production queue owner, whose exit shuts the adapter (and thus the agent,
// and thus the CLI running the close) down. It is exactly this cascade that
// made the pre-fix order lose the write.
const INTERMEDIATE_SCRIPT = `
const { spawn } = require('node:child_process');
// With node -e, extra args start at process.argv[1] (there is no script path).
const [childScript, sessionId, goFile] = process.argv.slice(1);
const child = spawn(process.execPath, [childScript, sessionId, goFile], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});
process.on('SIGTERM', () => {
  try { child.kill('SIGKILL'); } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

test("self-close: the terminal record lands closed:true even though the own owner is terminated", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "self-close-rig";
    await seedSessionRecord(homeDir, sessionId);

    const observed: ObservedRequest[] = [];
    const server = createRecordingOwnerServer(observed);
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await listenServer(server, socketPath);

    const goFile = path.join(homeDir, "self-close-go");
    // Planted owner: a REAL intermediate process between the test and the
    // close-running grandchild — i.e. a genuine ancestor of the closer.
    const intermediate = spawn(
      process.execPath,
      ["-e", INTERMEDIATE_SCRIPT, CHILD_PATH, sessionId, goFile],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let intermediateStderr = "";
    intermediate.stderr.setEncoding("utf8");
    intermediate.stderr.on("data", (chunk: string) => {
      intermediateStderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      intermediate.once("exit", (code) => resolve(code));
    });

    try {
      // Lease FIRST (with the real process identity, exactly as the owner
      // writes it), go-file LAST — the grandchild closes only after both.
      const processIdentity = intermediate.pid
        ? await readQueueOwnerProcessIdentity(intermediate.pid)
        : undefined;
      await writeQueueOwnerLock({
        lockPath,
        pid: intermediate.pid,
        sessionId,
        socketPath,
        processIdentity,
      });
      await fs.writeFile(goFile, "go\n");

      // The close terminates the own owner — the intermediate MUST die.
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("intermediate owner was never terminated")),
          30_000,
        );
        timer.unref?.();
      });
      const exitCode = await Promise.race([exited, timeout]);
      assert.equal(
        exitCode,
        0,
        `the owner was SIGTERMed by the self-close (its handler exits 0); stderr: ${intermediateStderr}`,
      );

      // The skipped steps never reached the owner.
      assert.deepEqual(
        observed,
        [],
        "the self arm must skip the drain and the ACP shutdown — both target the doomed owner",
      );

      // THE FIX, asserted on disk: the terminal record outlived the kill.
      const filePath = path.join(
        homeDir,
        ".acpx",
        "sessions",
        `${encodeURIComponent(sessionId)}.json`,
      );
      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      assert.equal(stored.closed, true, "the self-close must persist closed:true");
      assert.equal(typeof stored.closed_at, "string");
      assert.equal(stored.pid, undefined, "the closed record must not name a live pid");
    } finally {
      if (intermediate.exitCode == null && intermediate.signalCode == null) {
        intermediate.kill("SIGKILL");
      }
      await closeServer(server).catch(() => {
        // already closed
      });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) guard rows — a lease that does not name a live, identity-matched
// ancestor of the caller must NOT take the self arm.
// ---------------------------------------------------------------------------

test("self-close: a stale (dead-pid) lease does not route to the self arm", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "self-close-stale";
    await seedSessionRecord(homeDir, sessionId);
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ lockPath, pid: 999_999_999, sessionId, socketPath });

    const result = await closeSession(sessionId);

    // The non-self path still ATTEMPTS the drain (nothing to reach here) —
    // distinct from the self arm's attempted:false.
    assert.equal(result.drain.attempted, true, "a non-self close keeps the barrier");
    assert.equal(result.record.closed, true);
  });
});

test("self-close: a live owner that is not an ancestor takes the non-self path", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "self-close-foreign";
    await seedSessionRecord(homeDir, sessionId);

    // A live keeper whose pid is NOT in this process's ancestry — the exact
    // shape the proven non-self rows (queue-close-barrier) plant.
    const keeper = await spawnKeeper();
    const observed: ObservedRequest[] = [];
    const server = createRecordingOwnerServer(observed);
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await listenServer(server, socketPath);
    const processIdentity = keeper.pid
      ? await readQueueOwnerProcessIdentity(keeper.pid)
      : undefined;
    await writeQueueOwnerLock({
      lockPath,
      pid: keeper.pid,
      sessionId,
      socketPath,
      processIdentity,
    });

    try {
      const result = await closeSession(sessionId);

      assert.deepEqual(
        observed.map((entry) => entry.type),
        ["drain_deliveries", "close_session"],
        "a foreign live owner keeps the exact non-self sequence",
      );
      assert.equal(result.drain.attempted, true);
      assert.equal(result.record.closed, true);
    } finally {
      if (keeper.exitCode == null && keeper.signalCode == null) {
        keeper.kill("SIGKILL");
      }
      await closeServer(server).catch(() => {
        // already closed
      });
    }
  });
});
