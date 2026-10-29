// brick://d5ccb32f (RCA brick://4ef1e96b) — A CLOSE ADDRESSED AT A CHILD NEVER CLOSES THE CALLER.
//
// Every orchestrator runs `acpx sessions close --seat <child>` hourly, from a process that
// descends from its OWN queue owner. The only place the caller's ancestry enters the close logic
// is the self-close arm (`closeSession` → `detectSelfOwnedOwner`, session-control.ts): it fires
// when the TARGET session's owner is an ancestor of the closing process. This file pins that the
// target alone decides it — a child-addressed close takes the ordinary arm, writes ONE record,
// and never touches the parent or the parent's owner.
//
// Real processes, nothing mocked on the property under test: a PARENT session P whose owner is a
// real process (control socket + lease with its genuine birth identity) and which is the genuine
// ancestor of the real CLI (test/close-caller-owner.ts: owner → runner → CLI); a CHILD session C
// on its own seat with its own live owner. The CLI env carries P's agent identity, as in
// production.
//
// Each negative row has a planted positive of the same shape (the close addressed at P's OWN
// seat / id), which DOES take the self arm — so the negative is proven able to fail.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive, readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import { toSessionIndexEntry, writeSessionIndex } from "../src/session/persistence/index.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import {
  ChildLines,
  childEnv,
  readIndexEntry,
  readRecordOnDisk,
  recordFileName,
  sessionsDirOf,
} from "./index-lock-holder-helpers.js";
import "./install-owner-reaper.js";
import {
  closeServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const OWNER_PATH = fileURLToPath(new URL("./close-caller-owner.js", import.meta.url));

const PARENT_ID = "caller-parent-session";
const CHILD_ID = "caller-child-session";
const PARENT_SEAT = "11111111-1111-4111-8111-111111111111";
const CHILD_SEAT = "22222222-2222-4222-8222-222222222222";

type Observed = { type: string; reason?: string; timeoutMs?: number };

async function seedStore(
  homeDir: string,
  cwds: { parent: string; child: string },
): Promise<{ parentFileBefore: string }> {
  const dir = sessionsDirOf(homeDir);
  await fs.mkdir(dir, { recursive: true });
  const entries = [];
  for (const [id, seatId, cwd] of [
    [PARENT_ID, PARENT_SEAT, cwds.parent],
    [CHILD_ID, CHILD_SEAT, cwds.child],
  ] as const) {
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd,
      seatId,
      holderOrdinal: 1,
      holderActive: true,
    });
    const file = recordFileName(id);
    await fs.writeFile(
      path.join(dir, file),
      `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
      "utf8",
    );
    entries.push(toSessionIndexEntry(record, file));
  }
  await writeSessionIndex(dir, { files: entries.map((entry) => entry.file).toSorted(), entries });
  // The store is one JSON object keyed by seat_id (raw bytes, like test/seat-store-hold.test.ts,
  // so the fixture cannot mask a defect in the writer).
  const seatRow = (seatId: string, holder: string) => ({
    seat_id: seatId,
    created_at: "2026-01-01T00:00:00.000Z",
    active_holder_id: holder,
    next_ordinal: 2,
    closed_at: null,
  });
  await fs.writeFile(
    path.join(dir, "seats.json"),
    `${JSON.stringify({
      [PARENT_SEAT]: seatRow(PARENT_SEAT, PARENT_ID),
      [CHILD_SEAT]: seatRow(CHILD_SEAT, CHILD_ID),
    })}\n`,
    "utf8",
  );
  return { parentFileBefore: await fs.readFile(path.join(dir, recordFileName(PARENT_ID)), "utf8") };
}

// The CHILD's owner: a real keeper process (not an ancestor of the CLI) behind a recording socket.
async function plantChildOwner(homeDir: string) {
  const keeper = await startKeeperProcess();
  const observed: Observed[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {
      // a close racing the socket is normal here
    });
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
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
            `${JSON.stringify({ type: "close_session_result", requestId: request.requestId, closed: true })}\n`,
          );
        }
        socket.end();
      }
    });
  });
  const { lockPath, socketPath } = queuePaths(homeDir, CHILD_ID);
  await listenServer(server, socketPath);
  await writeQueueOwnerLock({
    lockPath,
    pid: keeper.pid,
    sessionId: CHILD_ID,
    socketPath,
    processIdentity: keeper.pid ? await readQueueOwnerProcessIdentity(keeper.pid) : undefined,
  });
  return { keeper, server, observed };
}

type CliResult = { code: number | null; signal: string | null; stdout: string; stderr: string };

async function readJsonLines(file: string): Promise<Observed[]> {
  try {
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Observed);
  } catch {
    return [];
  }
}

async function waitFor(what: string, timeoutMs: number, ready: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `${what} never happened within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Rig = {
  homeDir: string;
  parentOwner: ChildLines;
  parentPid: number;
  markerFile: string;
  observedFile: string;
  resultFile: string;
  parentLeaseBefore: string;
  parentFileBefore: string;
  child: Awaited<ReturnType<typeof plantChildOwner>>;
};

// Runs `closeArgs` (everything after `acpx`) as a descendant of P's owner.
async function withCallerRig(
  cwds: { parent: string; child: string },
  closeArgs: (ids: { seat: string; sessionId: string }) => string[],
  assertions: (rig: Rig) => Promise<void>,
): Promise<void> {
  await withTempHome(async (homeDir) => {
    const resolved = {
      parent: path.join(homeDir, cwds.parent),
      child: path.join(homeDir, cwds.child),
    };
    const { parentFileBefore } = await seedStore(homeDir, resolved);
    const child = await plantChildOwner(homeDir);
    const { lockPath, socketPath } = queuePaths(homeDir, PARENT_ID);
    const markerFile = path.join(homeDir, "parent-owner-sigterm");
    const observedFile = path.join(homeDir, "parent-owner-observed.jsonl");
    const resultFile = path.join(homeDir, "cli-result.json");
    const goFile = path.join(homeDir, "go");
    const env = childEnv(homeDir);
    // P's agent identity, as the parent agent's Bash carries it in production.
    env.ACPX_SESSION_URL = `https://atrium.example.test/?session=${PARENT_ID}`;
    env.ACPX_SEAT_URL = `https://atrium.example.test/?seat=${PARENT_SEAT}`;
    env.ACPX_SESSION_NAME = "caller-parent";
    const parentOwner = new ChildLines(
      spawn(
        process.execPath,
        [
          OWNER_PATH,
          socketPath,
          observedFile,
          markerFile,
          resultFile,
          goFile,
          CLI_PATH,
          resolved.parent,
          JSON.stringify(closeArgs({ seat: CHILD_SEAT, sessionId: CHILD_ID })),
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const parentPid = parentOwner.child.pid as number;
    try {
      await parentOwner.line("READY", 20_000);
      await writeQueueOwnerLock({
        lockPath,
        pid: parentPid,
        sessionId: PARENT_ID,
        socketPath,
        processIdentity: await readQueueOwnerProcessIdentity(parentPid),
      });
      const parentLeaseBefore = await fs.readFile(lockPath, "utf8");
      await fs.writeFile(goFile, "go\n");
      await assertions({
        homeDir,
        parentOwner,
        parentPid,
        markerFile,
        observedFile,
        resultFile,
        parentLeaseBefore,
        parentFileBefore,
        child,
      });
    } finally {
      stopProcess(parentOwner.child);
      stopProcess(child.keeper);
      await closeServer(child.server).catch(() => {
        // already closed
      });
    }
  });
}

async function readCliResult(resultFile: string): Promise<CliResult> {
  await waitFor("the CLI close finishing", 60_000, async () => {
    try {
      await fs.stat(resultFile);
      return true;
    } catch {
      return false;
    }
  });
  return JSON.parse(await fs.readFile(resultFile, "utf8")) as CliResult;
}

const SELECTORS = {
  "--seat": (ids: { seat: string }) => ["sessions", "close", "--seat", ids.seat],
  "--session-id": (ids: { sessionId: string }) => [
    "sessions",
    "close",
    "--session-id",
    ids.sessionId,
  ],
};
const CWD_SHAPES = {
  // The incident: parent and child both at the same cwd.
  "shared cwd": { parent: "projects", child: "projects" },
  "distinct cwds": { parent: "parent-cwd", child: "child-cwd" },
};

for (const [selectorName, selectorArgs] of Object.entries(SELECTORS)) {
  for (const [shapeName, cwds] of Object.entries(CWD_SHAPES)) {
    test(`close ${selectorName} <child> from under the PARENT's owner closes the child only (${shapeName})`, async () => {
      await withCallerRig(cwds, selectorArgs, async (rig) => {
        const cli = await readCliResult(rig.resultFile);
        assert.equal(cli.code, 0, `CLI rc; stderr=${cli.stderr}`);

        // The read-back names the CHILD, on line 1 and on the last line alone (`| tail -1`).
        const lines = cli.stdout.trim().split("\n");
        assert.equal(lines[0], CHILD_ID);
        assert.equal(
          lines.at(-1),
          `closed: true (read back from record ${CHILD_ID})`,
          "the last line alone must name the closed record",
        );
        assert.ok(
          !cli.stdout.includes(PARENT_ID),
          "the parent must not appear in the close output",
        );

        // The child: closed on disk and in the index, through the ordinary arm (drain + close_session)
        // and its own owner terminated.
        const childRecord = await readRecordOnDisk(rig.homeDir, CHILD_ID);
        assert.equal(childRecord.closed, true);
        assert.equal(typeof childRecord.closed_at, "string");
        assert.equal((await readIndexEntry(rig.homeDir, CHILD_ID))?.closed, true);
        assert.deepEqual(
          rig.child.observed.map((entry) => entry.type),
          // brick ad6ba1c2: the background-task gate's READ-ONLY query comes first, before anything
          // is touched; then the ordinary arm; then (v3.1) a re-read right before the stop.
          ["query_background_tasks", "drain_deliveries", "close_session", "query_background_tasks"],
          "the child's close takes the ordinary arm",
        );
        assert.equal(
          rig.child.keeper.pid !== undefined && isProcessAlive(rig.child.keeper.pid),
          false,
          "the child's own owner is terminated",
        );

        // The parent: record byte-identical (every lifecycle field), index still open, owner alive
        // and never signalled, never drained, lease and seat row untouched.
        const dir = sessionsDirOf(rig.homeDir);
        assert.equal(
          await fs.readFile(path.join(dir, recordFileName(PARENT_ID)), "utf8"),
          rig.parentFileBefore,
          "the parent's record must be byte-identical after a close addressed at its child",
        );
        assert.equal((await readRecordOnDisk(rig.homeDir, PARENT_ID)).closed, false);
        assert.equal((await readIndexEntry(rig.homeDir, PARENT_ID))?.closed, false);
        assert.equal(isProcessAlive(rig.parentPid), true, "the parent's owner must still be alive");
        await assert.rejects(fs.stat(rig.markerFile), "the parent's owner must never be signalled");
        assert.deepEqual(
          await readJsonLines(rig.observedFile),
          [],
          "nothing may be sent to the parent's owner",
        );
        const { lockPath } = queuePaths(rig.homeDir, PARENT_ID);
        assert.equal(await fs.readFile(lockPath, "utf8"), rig.parentLeaseBefore);
        const seats = JSON.parse(await fs.readFile(path.join(dir, "seats.json"), "utf8")) as Record<
          string,
          { closed_at: unknown; active_holder_id: unknown }
        >;
        assert.equal(seats[PARENT_SEAT]?.closed_at, null);
        assert.equal(seats[PARENT_SEAT]?.active_holder_id, PARENT_ID);
      });
    });
  }
}

// The planted positives: the SAME rig, the SAME caller, but the close is addressed at P's OWN
// seat / id. That is the self-close arm — P's owner is told (one zero-timeout drain), terminated
// as the final act, and P's record lands closed:true — so every negative row above is proven able
// to fail. The child is untouched.
for (const [selectorName, selectorArgs] of Object.entries(SELECTORS)) {
  test(`planted positive: close ${selectorName} <parent's own> from under its owner DOES self-close it`, async () => {
    await withCallerRig(
      CWD_SHAPES["shared cwd"],
      () => selectorArgs({ seat: PARENT_SEAT, sessionId: PARENT_ID }),
      async (rig) => {
        await waitFor(
          "the parent's owner being terminated by the self-close",
          60_000,
          async () =>
            rig.parentOwner.child.exitCode !== null || rig.parentOwner.child.signalCode !== null,
        );
        assert.equal(rig.parentOwner.child.exitCode, 0, `stderr=${rig.parentOwner.stderr}`);
        assert.equal(await fs.readFile(rig.markerFile, "utf8"), "SIGTERM\n");
        assert.deepEqual(
          await readJsonLines(rig.observedFile),
          // brick ad6ba1c2: the gate's read-only query precedes the self arm's single drain.
          [
            { type: "query_background_tasks" },
            { type: "drain_deliveries", reason: "session-close", timeoutMs: 0 },
          ],
          "the self arm sends the owner one zero-timeout close drain and no close_session",
        );
        const parentRecord = await readRecordOnDisk(rig.homeDir, PARENT_ID);
        assert.equal(parentRecord.closed, true, "the self arm must persist closed:true");

        // The child is untouched by a self-close of the parent.
        assert.equal((await readRecordOnDisk(rig.homeDir, CHILD_ID)).closed, false);
        assert.deepEqual(rig.child.observed, []);
        assert.equal(
          rig.child.keeper.pid !== undefined && isProcessAlive(rig.child.keeper.pid),
          true,
        );
      },
    );
  });
}
