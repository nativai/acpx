import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDrainTimeoutMs } from "../src/cli/flags.js";
import { isProcessAlive, readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import { closeSession } from "../src/cli/session/session-control.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import type { SessionRecord } from "../src/types.js";
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

// ---------------------------------------------------------------------------
// D1 stage 2 — the closeSession BARRIER and its CLI surface (brick://53437107).
// Gates L1.9 (ordering), L1.10 (graceful degradation, E2/E3) and L1.11 (the CLI).
//
// L1.9 is asserted by ORDERING OBSERVATION — a mock owner records the sequence of
// control requests it actually receives, and whether its process was still alive
// when each arrived. Reading the source to confirm the call order would prove
// nothing about the shipped binary.
// ---------------------------------------------------------------------------

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type ObservedRequest = {
  type: string;
  ownerAliveOnArrival: boolean;
};

type MockOwnerOptions = {
  // What the owner reports it lost. Empty = clean close.
  undelivered?: Array<{ requestId: string; messageId?: string }>;
  // Emulate an owner running PRE-DRAIN code: it does not know the verb, so it
  // answers exactly as the deployed owner does — an error frame whose requestId
  // is the literal "unknown" (ipc-server's failRequest for an unparseable type).
  unknownVerb?: boolean;
  // Emulate a wedged owner for the DRAIN only: accept the connection, never
  // answer `drain_deliveries`. Other verbs still answer.
  //
  // Deliberately scoped to the drain, so the gate that uses it proves the
  // BARRIER's bound specifically and nothing more. `silentAll` below is the
  // separate, wider gate for the whole close path.
  silentDrain?: boolean;
  // Mute to EVERY verb — the wedged owner that used to hang a close forever.
  // The drain (step 0.5) and close_session (step 1) are both bounded now; the
  // remaining four control verbs are not (brick://11b83b47), so this option is
  // only valid for close-path gates.
  silentAll?: boolean;
};

// A multi-connection mock queue owner. Each control request opens its own
// connection, so this records the whole sequence the close actually performs.
function createRecordingOwnerServer(
  observed: ObservedRequest[],
  ownerPid: () => number | undefined,
  options: MockOwnerOptions = {},
): net.Server {
  return net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => {
      // a close racing the socket is normal here
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        return;
      }
      const request = JSON.parse(line) as { requestId: string; type: string };
      const pid = ownerPid();
      observed.push({
        type: request.type,
        ownerAliveOnArrival: pid !== undefined && isProcessAlive(pid),
      });

      if (options.silentAll) {
        return;
      }
      if (options.silentDrain && request.type === "drain_deliveries") {
        return;
      }
      if (options.unknownVerb && request.type === "drain_deliveries") {
        socket.write(
          `${JSON.stringify({
            type: "error",
            requestId: "unknown",
            code: "RUNTIME",
            detailCode: "QUEUE_REQUEST_INVALID",
            origin: "queue",
            retryable: false,
            message: "Invalid queue request",
          })}\n`,
        );
        socket.end();
        return;
      }

      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      if (request.type === "drain_deliveries") {
        socket.write(
          `${JSON.stringify({
            type: "drain_deliveries_result",
            requestId: request.requestId,
            drained: options.undelivered?.length ?? 0,
            undelivered: options.undelivered ?? [],
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
    });
  });
}

async function seedSessionRecord(homeDir: string, sessionId: string): Promise<SessionRecord> {
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
  return record;
}

type PlantedOwner = {
  keeper: Awaited<ReturnType<typeof startKeeperProcess>>;
  server: net.Server;
};

// A live, signalable owner: a real keeper process (so the lease pid is alive and
// terminate has something to kill), its control socket, and a matching lease.
async function plantLiveOwner(
  homeDir: string,
  sessionId: string,
  observed: ObservedRequest[],
  options: MockOwnerOptions = {},
): Promise<PlantedOwner> {
  const keeper = await startKeeperProcess();
  const server = createRecordingOwnerServer(observed, () => keeper.pid, options);
  const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
  await listenServer(server, socketPath);
  const processIdentity = keeper.pid ? await readQueueOwnerProcessIdentity(keeper.pid) : undefined;
  await writeQueueOwnerLock({ lockPath, pid: keeper.pid, sessionId, socketPath, processIdentity });
  return { keeper, server };
}

async function teardownOwner(owner: PlantedOwner): Promise<void> {
  stopProcess(owner.keeper);
  await closeServer(owner.server).catch(() => {
    // already closed
  });
}

// L1.9 — the drain must run BEFORE anything terminates the owner. Asserted by
// observing the order requests actually arrive, and by checking the owner was
// still alive when the drain reached it.
test("L1.9 closeSession drains before it terminates the owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-ordering";
    await seedSessionRecord(homeDir, sessionId);
    const observed: ObservedRequest[] = [];
    const owner = await plantLiveOwner(homeDir, sessionId, observed, {
      undelivered: [{ requestId: "req-a", messageId: "msg-a" }],
    });

    try {
      const result = await closeSession(sessionId);

      assert.deepEqual(
        observed.map((entry) => entry.type),
        ["drain_deliveries", "close_session"],
        "the drain is step 0.5: it must reach the owner before the ACP close and before terminate",
      );
      assert.equal(
        observed[0].ownerAliveOnArrival,
        true,
        "the owner must still be alive when the drain arrives — draining a corpse saves nothing",
      );
      assert.equal(result.drain.attempted, true);
      assert.equal(result.drain.reachedOwner, true);
      assert.deepEqual(result.drain.undelivered, [{ requestId: "req-a", messageId: "msg-a" }]);
      assert.equal(result.record.closed, true);

      // And the owner really was terminated afterwards.
      assert.equal(
        owner.keeper.pid !== undefined && isProcessAlive(owner.keeper.pid),
        false,
        "the close still terminates the owner after draining it",
      );
    } finally {
      await teardownOwner(owner);
    }
  });
});

// L1.10 / E2 — no owner at all. Must not throw, must still close, and must be
// distinguishable from "we asked and nothing was in flight".
test("L1.10/E2 closeSession with no live owner reports reachedOwner:false and still closes", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-no-owner";
    await seedSessionRecord(homeDir, sessionId);

    const result = await closeSession(sessionId);

    assert.equal(result.drain.attempted, true);
    assert.equal(
      result.drain.reachedOwner,
      false,
      "'we could not ask' must not be reported as 'nothing was in flight'",
    );
    assert.deepEqual(result.drain.undelivered, []);
    assert.equal(
      result.drain.turnSettled,
      undefined,
      "never guess a turn state we did not observe",
    );
    assert.equal(result.record.closed, true);
  });
});

// L1.10 / E3 — THE MIXED-FLEET GATE. Queue owners are long-lived processes that a
// deploy does not restart, so for as long as an owner stays busy it keeps running
// pre-drain code and rejects the verb as unparseable. That must degrade to E2,
// not to an error — this is what makes the staged rollout safe.
test("L1.10/E3 an owner that does not know the drain verb degrades to reachedOwner:false", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-old-owner";
    await seedSessionRecord(homeDir, sessionId);
    const observed: ObservedRequest[] = [];
    const owner = await plantLiveOwner(homeDir, sessionId, observed, { unknownVerb: true });

    try {
      const result = await closeSession(sessionId);

      assert.equal(observed[0]?.type, "drain_deliveries", "we still ask");
      assert.equal(result.drain.attempted, true);
      assert.equal(
        result.drain.reachedOwner,
        false,
        "an unparseable-verb rejection is not a drain",
      );
      assert.deepEqual(result.drain.undelivered, []);
      assert.equal(result.record.closed, true, "the close proceeds exactly as before the barrier");
    } finally {
      await teardownOwner(owner);
    }
  });
});

// L1.10 — a wedged owner must not hang the DRAIN beyond its own budget. The
// bound is asserted, not assumed: an unbounded drain would turn every close of a
// stuck session into a hang, which is worse than the bug being fixed.
//
// SCOPE, stated so this gate is not over-read: it proves the BARRIER's own bound
// and nothing wider. The whole close path is covered separately by the
// fully-mute-owner gate below.
test("L1.10 a mute owner cannot hang the drain beyond its budget", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-silent-owner";
    await seedSessionRecord(homeDir, sessionId);
    const observed: ObservedRequest[] = [];
    const owner = await plantLiveOwner(homeDir, sessionId, observed, { silentDrain: true });

    try {
      const startedAt = Date.now();
      const result = await closeSession(sessionId, { drainTimeoutMs: 100 });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.drain.reachedOwner, false);
      assert.equal(result.record.closed, true);
      assert.ok(
        observed.some((entry) => entry.type === "drain_deliveries"),
        "the drain was actually attempted against the mute owner",
      );
      // 100 ms budget + the client's 2 s slack, plus room for the terminate and
      // the record write on a loaded box.
      assert.ok(
        elapsedMs < 15_000,
        `close against a drain-mute owner took ${elapsedMs}ms — the drain is not bounded`,
      );
    } finally {
      await teardownOwner(owner);
    }
  });
});

// `--no-drain` — the explicit escape hatch back to the pre-barrier behaviour.
// THE WIDENED GATE. Before this brick, an owner that accepted the connection and
// then said nothing hung `acpx sessions close` INDEFINITELY at step 1 —
// `runQueueOwnerRequest` carried no client-side timer at all. That defeats
// acceptance criterion #1: an agent cannot be told in its own shell, at that
// moment, by a command that never returns.
//
// Both close-path verbs are now bounded: the drain (step 0.5) and close_session
// (step 1). The gate asserts the OUTCOME an agent cares about — the close
// terminates, reports honestly, and still kills the owner.
//
// SCOPE, so this is not over-read: the other four control verbs remain unbounded
// (brick://11b83b47). This proves the CLOSE PATH terminates, not the whole
// control surface.
test("a fully mute owner cannot hang the close path", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-mute-owner";
    await seedSessionRecord(homeDir, sessionId);
    const observed: ObservedRequest[] = [];
    const owner = await plantLiveOwner(homeDir, sessionId, observed, { silentAll: true });

    try {
      const startedAt = Date.now();
      const result = await closeSession(sessionId, { drainTimeoutMs: 100 });
      const elapsedMs = Date.now() - startedAt;

      assert.deepEqual(
        observed.map((entry) => entry.type),
        ["drain_deliveries", "close_session"],
        "both close-path verbs are still attempted against a mute owner",
      );
      assert.equal(result.drain.reachedOwner, false);
      assert.equal(result.record.closed, true, "the close still completes");
      assert.ok(
        elapsedMs < 30_000,
        `close against a fully mute owner took ${elapsedMs}ms — the close path is not bounded`,
      );
    } finally {
      await teardownOwner(owner);
    }
  });
});

test("L1.11 --no-drain skips the barrier entirely", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-no-drain";
    await seedSessionRecord(homeDir, sessionId);
    const observed: ObservedRequest[] = [];
    const owner = await plantLiveOwner(homeDir, sessionId, observed, {
      undelivered: [{ requestId: "req-skip", messageId: "msg-skip" }],
    });

    try {
      const result = await closeSession(sessionId, { drain: false });

      assert.ok(
        !observed.some((entry) => entry.type === "drain_deliveries"),
        "--no-drain must not send the verb at all",
      );
      assert.equal(result.drain.attempted, false);
      assert.equal(result.drain.reachedOwner, false);
      assert.deepEqual(result.drain.undelivered, []);
      assert.equal(result.record.closed, true);
    } finally {
      await teardownOwner(owner);
    }
  });
});

test("L1.11 --drain-timeout parsing accepts 0 and rejects negatives and junk", () => {
  assert.equal(parseDrainTimeoutMs("0"), 0);
  assert.equal(parseDrainTimeoutMs("5000"), 5000);
  assert.throws(() => parseDrainTimeoutMs("-1"));
  assert.throws(() => parseDrainTimeoutMs("abc"));
  assert.throws(() => parseDrainTimeoutMs("1.5"));
});

// THE WARNING MUST NOT ASSERT AN EVENT acpx DID NOT WITNESS.
//
// This program exists because acpx-ui invented a terminal it never observed and
// stamped it with a borrowed timestamp; corollary C-3 requires invented and
// witnessed outcomes to stay distinguishable. A close warning that fabricated
// detail would reproduce the defect inside the feature meant to fix it — so the
// text is a contract, not cosmetics, and it gets a gate.
//
// The two specific fabrications this pins out:
//   - naming the SENDER, which lives only in acpx-ui's sidecar (KD-1);
//   - claiming the sender "has been notified", which acpx cannot observe and
//     which is outright FALSE for a plain CLI prompt (E10): no sidecar row, so
//     no sender exists to notify.
test("the lost-custody warning states only what acpx witnessed", async () => {
  const { warnUndeliveredCustody } = await import("../src/cli/output/render.js");
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    warnUndeliveredCustody("worker-7", {
      attempted: true,
      reachedOwner: true,
      turnSettled: true,
      undelivered: [
        { requestId: "req-1", messageId: "msg-1" },
        // E10 — a plain CLI prompt: no messageId, no acpx-ui counterpart, and
        // therefore provably no sender to have notified.
        { requestId: "req-2" },
      ],
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const output = written.join("");

  // What acpx DOES know, and what the agent needs in order to act.
  assert.match(output, /worker-7/);
  assert.match(output, /2 undelivered messages/);
  assert.match(output, /msg-1/);
  assert.match(output, /req-2/, "an item with no messageId must still be named");
  assert.match(output, /safe to resend/);

  // What acpx does NOT know. These are the regressions worth catching.
  assert.doesNotMatch(
    output,
    /has been notified|have been notified/,
    "acpx cannot observe acpx-ui notifying a sender, and for a CLI prompt there is no sender at all",
  );
  assert.doesNotMatch(
    output,
    /from acpx session|sender-url|https?:\/\//,
    "acpx has no reader for the delivery sidecar (KD-1) and cannot name a sender",
  );
});

type CliResult = { code: number | null; stdout: string; stderr: string };

async function runCloseCli(args: string[], homeDir: string, cwd: string): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    for (const key of ["ACPX_SESSION_URL", "ACPX_SESSION_NAME", "ACPX_PARENT_SESSION_URL"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// L1.11 — THE EXIT-CODE CONTRACT (KD-5). Exit 0 by default even when custody was
// lost, because many fleet call-sites run `sessions close` under `set -e` as
// their final act and a non-zero default would abort wrap-ups fleet-wide. The
// missing thing was SIGNAL, not exit status — so the warning block is mandatory
// on both runs, and only `--fail-on-undelivered` opts into exit 3.
test("L1.11 lost custody warns on stderr, exits 0 by default and 3 with --fail-on-undelivered", async () => {
  await withTempHome(async (homeDir) => {
    for (const strict of [false, true]) {
      const sessionId = `barrier-cli-${strict ? "strict" : "default"}`;
      await seedSessionRecord(homeDir, sessionId);
      const observed: ObservedRequest[] = [];
      const owner = await plantLiveOwner(homeDir, sessionId, observed, {
        undelivered: [{ requestId: "req-cli", messageId: "msg-cli-lost" }],
      });

      try {
        const result = await runCloseCli(
          // `--format` is a GLOBAL option: it must precede the agent and the
          // subcommand (the program uses enablePositionalOptions).
          [
            "--format",
            "json",
            "claude",
            "sessions",
            "close",
            "--session-id",
            sessionId,
            ...(strict ? ["--fail-on-undelivered"] : []),
          ],
          homeDir,
          homeDir,
        );

        assert.equal(
          result.code,
          strict ? 3 : 0,
          `expected exit ${strict ? 3 : 0}; stderr was:\n${result.stderr}`,
        );

        // The loud block is on STDERR on BOTH runs — losing a message must never
        // be silent, whether or not the caller opted into a failing exit.
        assert.match(result.stderr, /undelivered message/);
        assert.match(result.stderr, /msg-cli-lost/);
        assert.match(result.stderr, /safe to resend/);
        assert.doesNotMatch(
          result.stderr,
          /has been notified/,
          "the warning must not assert a downstream event acpx never witnessed",
        );

        // And --format json carries the machine-readable shape on stdout.
        const payload = JSON.parse(result.stdout.trim()) as {
          action: string;
          drain: {
            attempted: boolean;
            reachedOwner: boolean;
            turnSettled?: boolean;
            undelivered: Array<{ requestId: string; messageId?: string }>;
          };
        };
        assert.equal(payload.action, "session_closed");
        assert.equal(payload.drain.attempted, true);
        assert.equal(payload.drain.reachedOwner, true);
        assert.equal(payload.drain.turnSettled, true);
        assert.deepEqual(payload.drain.undelivered, [
          { requestId: "req-cli", messageId: "msg-cli-lost" },
        ]);
      } finally {
        await teardownOwner(owner);
      }
    }
  });
});

// L4.5 / T16 — THE HAPPY PATH MUST STAY FREE. Closing an idle session with an
// empty queue is the overwhelmingly common case; a barrier that taxes it, or
// that prints anything, is a regression.
test("L1.11 a clean close prints no warning, exits 0, and reports an empty drain", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "barrier-clean-close";
    await seedSessionRecord(homeDir, sessionId);
    const observed: ObservedRequest[] = [];
    const owner = await plantLiveOwner(homeDir, sessionId, observed, { undelivered: [] });

    try {
      const result = await runCloseCli(
        ["--format", "json", "claude", "sessions", "close", "--session-id", sessionId],
        homeDir,
        homeDir,
      );

      assert.equal(result.code, 0);
      assert.doesNotMatch(result.stderr, /undelivered/);
      const payload = JSON.parse(result.stdout.trim()) as {
        drain: { reachedOwner: boolean; undelivered: unknown[] };
      };
      assert.equal(payload.drain.reachedOwner, true);
      assert.deepEqual(payload.drain.undelivered, []);
    } finally {
      await teardownOwner(owner);
    }
  });
});
