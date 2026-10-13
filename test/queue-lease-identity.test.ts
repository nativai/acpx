import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { probeQueueOwnerHealth } from "../src/cli/queue/ipc-health.js";
import { trySubmitToRunningOwner } from "../src/cli/queue/ipc.js";
import { withQueueLeaseMutation } from "../src/cli/queue/lease-mutation.js";
import {
  readQueueOwnerProcessIdentity,
  readQueueOwnerRecord,
  readQueueOwnerState,
  readQueueOwnerStatus,
  recoverQueueOwnerForSession,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  type QueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { queueLockFilePath, queueSharedSocketDir } from "../src/cli/queue/paths.js";
import { QueueConnectionError } from "../src/errors.js";
import {
  getOwnProcessScope,
  readProcessBirthIdentity,
  setProcReaderForTests,
} from "../src/process-identity.js";
import { signalVerifiedProcess } from "../src/process-signal.js";
import type { OutputFormatter } from "../src/types.js";
import {
  closeServer,
  createSingleRequestServer,
  listenServer,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

/** The pid of a spawned child — asserted present (lint and the compiler disagree on `!` here). */
function pidOf(child: { pid?: number }): number {
  assert.ok(child.pid, "child has a pid");
  return child.pid;
}

// brick ae547131 §12.1 B/C/D — the lease decision table (T04), read verbs never reaping a live lease
// (T05), no second owner (T06), the F4 boundaries (T07), a foreign owner never signalled (T08) and
// its positive control (T09), the fence (T12), the unparsable lease (T12b), the guard (T13), close
// never signalling a successor (T33), the /proc self-check (T35), the IPC auto-recoveries (T36).
//
// Foreign scope is faked the way CONCEPT §12.1 prescribes: our own boot and time namespace with
// `pidNamespace: "pid:[1]"`, and a pid that is alive (or dead) HERE. T29 (the real workbench pod)
// is the out-of-suite counterpart.

const linux = process.platform === "linux";
const FOREIGN_NS = "pid:[1]";

const NOOP_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  onPermissionEscalation() {},
  flush() {},
};

function key(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

/** A socket path on the SHARED volume (`<home>/.acpx/q/`), where a refused/absent ping is evidence. */
function sharedSocketPath(homeDir: string, sessionId: string): string {
  return path.join(queueSharedSocketDir(homeDir), `${key(sessionId)}.sock`);
}

/** A pod-local `/tmp` socket path (the pre-0a location): a ping there proves nothing (row F5). */
function tmpSocketPath(sessionId: string): string {
  return path.join("/tmp", `acpx-0123456789`, `${key(sessionId)}.sock`);
}

async function leaseIdentity(
  pid: number,
  scope: Record<string, string> = {},
): Promise<Record<string, string>> {
  const identity = await readQueueOwnerProcessIdentity(pid);
  assert.ok(identity, `identity of ${pid}`);
  return { ...identity, ...scope };
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

/** A socket FILE whose listener is gone (killed without unlinking) — ECONNREFUSED (CONCEPT A.4). */
async function refusedSocket(socketPath: string): Promise<void> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('up'))",
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  await fs.access(socketPath); // the file outlived its listener
}

async function listeningSocket(socketPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end());
  await listenServer(server, socketPath);
  return server;
}

async function fileFingerprint(filePath: string): Promise<string | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return `${stat.ino}:${createHash("sha256").update(raw).digest("hex")}`;
  } catch {
    return null;
  }
}

async function socketFingerprint(socketPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(socketPath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

type Row = {
  name: string;
  setup: (ctx: RowContext) => Promise<void>;
  state: string;
  alive: boolean | null;
  scope: string;
  recoverable: boolean;
};

type RowContext = {
  homeDir: string;
  sessionId: string;
  lockPath: string;
  keeper: ChildProcess;
  servers: net.Server[];
};

async function writeLease(
  ctx: RowContext,
  fields: {
    pid: number;
    socketPath: string;
    processIdentity?: Record<string, string>;
    heartbeatAgeMs?: number;
    host?: string;
  },
): Promise<void> {
  await writeQueueOwnerLock({
    lockPath: ctx.lockPath,
    pid: fields.pid,
    sessionId: ctx.sessionId,
    socketPath: fields.socketPath,
    processIdentity: fields.processIdentity,
    heartbeatAt: ago(fields.heartbeatAgeMs ?? 0),
    host: fields.host,
  });
}

const ROWS: Row[] = [
  {
    name: "L1 local · alive · start equal",
    setup: async (ctx) => {
      const socketPath = sharedSocketPath(ctx.homeDir, ctx.sessionId);
      ctx.servers.push(await listeningSocket(socketPath));
      await writeLease(ctx, {
        pid: ctx.keeper.pid!,
        socketPath,
        processIdentity: await leaseIdentity(pidOf(ctx.keeper)),
      });
    },
    state: "healthy",
    alive: true,
    scope: "local",
    recoverable: false,
  },
  {
    name: "L2 local · alive · start differs",
    setup: async (ctx) => {
      const identity = await leaseIdentity(pidOf(ctx.keeper));
      await writeLease(ctx, {
        pid: ctx.keeper.pid!,
        socketPath: sharedSocketPath(ctx.homeDir, ctx.sessionId),
        processIdentity: {
          ...identity,
          startTimeTicks: String(Number(identity.startTimeTicks) + 1),
        },
      });
    },
    state: "pid_reused",
    alive: false,
    scope: "local",
    recoverable: true,
  },
  {
    name: "L3 local · ESRCH",
    setup: async (ctx) => {
      const child = await startKeeperProcess();
      const identity = await leaseIdentity(pidOf(child));
      stopProcess(child);
      await new Promise((resolve) => child.once("exit", resolve));
      await writeLease(ctx, {
        pid: child.pid!,
        socketPath: sharedSocketPath(ctx.homeDir, ctx.sessionId),
        processIdentity: identity,
      });
    },
    state: "dead_owner",
    alive: false,
    scope: "local",
    recoverable: true,
  },
  {
    name: "L4 local scope · alive · no start ticks (HoD: unverifiable, never signalled)",
    setup: async (ctx) => {
      const own = getOwnProcessScope()!;
      await writeLease(ctx, {
        pid: ctx.keeper.pid!,
        socketPath: sharedSocketPath(ctx.homeDir, ctx.sessionId),
        processIdentity: { kind: "linux-proc-stat-starttime", ...own },
      });
    },
    state: "owner_unverified",
    alive: true,
    scope: "local",
    recoverable: false,
  },
  {
    name: "F1 foreign · heartbeat fresh (pid dead HERE)",
    setup: async (ctx) => {
      const pid = await deadPid();
      await writeLease(ctx, {
        pid,
        socketPath: sharedSocketPath(ctx.homeDir, ctx.sessionId),
        processIdentity: await leaseIdentity(pidOf(ctx.keeper), { pidNamespace: FOREIGN_NS }),
        host: "dev-server-workbench-x",
      });
    },
    state: "foreign_owner",
    alive: true,
    scope: "foreign",
    recoverable: false,
  },
  {
    name: "F2 foreign · heartbeat 20 s · listening",
    setup: async (ctx) => {
      const socketPath = sharedSocketPath(ctx.homeDir, ctx.sessionId);
      ctx.servers.push(await listeningSocket(socketPath));
      await writeLease(ctx, {
        pid: await deadPid(),
        socketPath,
        processIdentity: await leaseIdentity(pidOf(ctx.keeper), { pidNamespace: FOREIGN_NS }),
        heartbeatAgeMs: 20_000,
      });
    },
    state: "foreign_owner",
    alive: true,
    scope: "foreign",
    recoverable: false,
  },
  {
    name: "F3 foreign · heartbeat 20 s · refused",
    setup: async (ctx) => {
      const socketPath = sharedSocketPath(ctx.homeDir, ctx.sessionId);
      await refusedSocket(socketPath);
      await writeLease(ctx, {
        pid: await deadPid(),
        socketPath,
        processIdentity: await leaseIdentity(pidOf(ctx.keeper), { pidNamespace: FOREIGN_NS }),
        heartbeatAgeMs: 20_000,
      });
    },
    state: "foreign_owner",
    alive: null,
    scope: "foreign",
    recoverable: false,
  },
  {
    name: "F4 foreign · heartbeat 31 s · absent under q/",
    setup: async (ctx) => {
      await writeLease(ctx, {
        pid: await deadPid(),
        socketPath: sharedSocketPath(ctx.homeDir, ctx.sessionId),
        processIdentity: await leaseIdentity(pidOf(ctx.keeper), { pidNamespace: FOREIGN_NS }),
        heartbeatAgeMs: 31_000,
      });
    },
    state: "dead_owner",
    alive: false,
    scope: "foreign",
    recoverable: true,
  },
  {
    name: "F5 foreign · heartbeat 10 min · pod-local /tmp socket",
    setup: async (ctx) => {
      await writeLease(ctx, {
        pid: await deadPid(),
        socketPath: tmpSocketPath(ctx.sessionId),
        processIdentity: await leaseIdentity(pidOf(ctx.keeper), { pidNamespace: FOREIGN_NS }),
        heartbeatAgeMs: 600_000,
      });
    },
    state: "foreign_owner",
    alive: null,
    scope: "foreign",
    recoverable: false,
  },
  {
    name: "G1 legacy · no scope · start ticks match",
    setup: async (ctx) => {
      const identity = await leaseIdentity(pidOf(ctx.keeper));
      const socketPath = sharedSocketPath(ctx.homeDir, ctx.sessionId);
      ctx.servers.push(await listeningSocket(socketPath));
      await writeLease(ctx, {
        pid: ctx.keeper.pid!,
        socketPath,
        processIdentity: { kind: identity.kind, startTimeTicks: identity.startTimeTicks },
      });
    },
    state: "healthy",
    alive: true,
    scope: "legacy",
    recoverable: false,
  },
];

async function withRow<T>(row: Row, run: (ctx: RowContext) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await withTempHome(async (homeDir) => {
    const keeper = await startKeeperProcess();
    const sessionId = `row-${row.name.slice(0, 2).toLowerCase()}`;
    const ctx: RowContext = {
      homeDir,
      sessionId,
      lockPath: queueLockFilePath(sessionId, homeDir),
      keeper,
      servers: [],
    };
    try {
      await row.setup(ctx);
      result = await run(ctx);
    } finally {
      for (const server of ctx.servers) {
        await closeServer(server);
      }
      stopProcess(keeper);
    }
  });
  return result as T;
}

for (const row of ROWS) {
  test(`T04 ${row.name} ⇒ ${row.state} / alive ${String(row.alive)}`, async (t) => {
    if (!linux) {
      t.skip("linux identity");
      return;
    }
    await withRow(row, async (ctx) => {
      const before = await fileFingerprint(ctx.lockPath);
      const state = await readQueueOwnerState(ctx.sessionId);
      assert.equal(state.state, row.state);
      assert.equal(state.alive, row.alive);
      assert.equal(state.scope, row.scope);
      assert.equal(state.recoverable, row.recoverable);
      // readQueueOwnerState is a read: the lease is never touched, whatever the row
      assert.equal(await fileFingerprint(ctx.lockPath), before);
    });
  });
}

/**
 * T05 (⊗ — d9ab5c0d unlinks the F1 lease on `acpx status`: pid ESRCH ⇒ dead_owner ⇒ reaped). Every
 * read path that used to reap: the status read (`readQueueOwnerStatus`, behind `acpx status`,
 * `sessions show/list`, render), the health probe behind every verb's fallback.
 */
for (const row of ROWS.filter((candidate) => !candidate.recoverable)) {
  test(`T05 read verbs never unlink a live lease: ${row.name}`, async (t) => {
    if (!linux) {
      t.skip("linux identity");
      return;
    }
    await withRow(row, async (ctx) => {
      const lease = await readQueueOwnerRecord(ctx.sessionId);
      assert.ok(lease);
      const before = await fileFingerprint(ctx.lockPath);
      const socketBefore = await socketFingerprint(lease.socketPath);
      const status = await readQueueOwnerStatus(ctx.sessionId);
      assert.ok(status, "status read reported no owner for a live lease");
      assert.notEqual(status.alive, false);
      await probeQueueOwnerHealth(ctx.sessionId);
      await readQueueOwnerState(ctx.sessionId);
      assert.equal(await fileFingerprint(ctx.lockPath), before, "lease changed by a read");
      assert.equal(
        await socketFingerprint(lease.socketPath),
        socketBefore,
        "socket changed by a read",
      );
    });
  });
}

test("T05 positive control: a read verb DOES reap a provably dead lease (L3, F4)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  for (const row of ROWS.filter(
    (candidate) => candidate.name.startsWith("L3") || candidate.name.startsWith("F4"),
  )) {
    await withRow(row, async (ctx) => {
      assert.equal(await readQueueOwnerStatus(ctx.sessionId), undefined);
      assert.equal(await fileFingerprint(ctx.lockPath), null, `${row.name}: dead lease not reaped`);
    });
  }
});

/** T06 (⊗ — d9ab5c0d reaps the F1 lease and cold-spawns a second owner). */
test("T06 no second owner: a prompt to a foreign owner reaches ITS socket; unreachable ⇒ QUEUE_OWNER_UNREACHABLE", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withTempHome(async (homeDir) => {
    const keeper = await startKeeperProcess();
    const sessionId = "t06-foreign";
    const socketPath = sharedSocketPath(homeDir, sessionId);
    const lockPath = queueLockFilePath(sessionId, homeDir);
    const received: string[] = [];
    const server = createSingleRequestServer((socket, request) => {
      received.push(request.type);
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      socket.end();
    });
    try {
      await listenServer(server, socketPath);
      await writeQueueOwnerLock({
        lockPath,
        pid: await deadPid(),
        sessionId,
        socketPath,
        processIdentity: await leaseIdentity(pidOf(keeper), { pidNamespace: FOREIGN_NS }),
      });
      const before = await fileFingerprint(lockPath);
      const outcome = await trySubmitToRunningOwner({
        sessionId,
        message: "hello",
        permissionMode: "approve-reads",
        outputFormatter: NOOP_OUTPUT_FORMATTER,
        waitForCompletion: false,
      });
      assert.ok(outcome, "the prompt did not reach the foreign owner");
      assert.deepEqual(received, ["submit_prompt"]);
      assert.equal(await fileFingerprint(lockPath), before, "the foreign lease was touched");

      // Variant: the foreign owner's socket is ABSENT — retryable error, lease unchanged, no spawn.
      await closeServer(server);
      await fs.rm(socketPath, { force: true });
      await assert.rejects(
        trySubmitToRunningOwner({
          sessionId,
          message: "hello",
          permissionMode: "approve-reads",
          outputFormatter: NOOP_OUTPUT_FORMATTER,
          waitForCompletion: false,
        }),
        (error: unknown) =>
          error instanceof QueueConnectionError &&
          error.detailCode === "QUEUE_OWNER_UNREACHABLE" &&
          error.retryable === true,
      );
      assert.equal(await fileFingerprint(lockPath), before, "the foreign lease was touched");
    } finally {
      stopProcess(keeper);
      await fs.rm(socketPath, { force: true });
    }
  });
});

/** T07 — the F4 reap and its boundaries, asserted on both sides. */
test("T07 F4 boundaries: 31 s + absent under q/ ⇒ reaped; 29 s ⇒ kept; 31 s + listening ⇒ kept; 10 min + /tmp ⇒ kept", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const cases: Array<{
    name: string;
    age: number;
    socket: "absent" | "listening" | "tmp";
    reaped: boolean;
  }> = [
    { name: "31 s absent", age: 31_000, socket: "absent", reaped: true },
    { name: "29 s absent", age: 29_000, socket: "absent", reaped: false },
    { name: "31 s listening", age: 31_000, socket: "listening", reaped: false },
    { name: "10 min /tmp", age: 600_000, socket: "tmp", reaped: false },
  ];
  for (const c of cases) {
    await withTempHome(async (homeDir) => {
      const keeper = await startKeeperProcess();
      const sessionId = `t07-${c.age}-${c.socket}`;
      const lockPath = queueLockFilePath(sessionId, homeDir);
      const socketPath =
        c.socket === "tmp" ? tmpSocketPath(sessionId) : sharedSocketPath(homeDir, sessionId);
      const server = c.socket === "listening" ? await listeningSocket(socketPath) : undefined;
      try {
        await writeQueueOwnerLock({
          lockPath,
          pid: await deadPid(),
          sessionId,
          socketPath,
          processIdentity: await leaseIdentity(pidOf(keeper), { pidNamespace: FOREIGN_NS }),
          heartbeatAt: ago(c.age),
        });
        // The reaping read, at once — the boundary is TIME, so the judgement must happen within the
        // fixture's age, not after the prompt path's ~2 s of connect retries (which correctly turns
        // a 29 s F3 into a 31 s F4).
        await readQueueOwnerStatus(sessionId);
        const remains = (await fileFingerprint(lockPath)) !== null;
        if (c.reaped) {
          // and the prompt path: the F4 is reaped and the caller falls through to a cold spawn
          await writeQueueOwnerLock({
            lockPath,
            pid: await deadPid(),
            sessionId,
            socketPath,
            processIdentity: await leaseIdentity(pidOf(keeper), { pidNamespace: FOREIGN_NS }),
            heartbeatAt: ago(c.age),
          });
          const outcome = await trySubmitToRunningOwner({
            sessionId,
            message: "hello",
            permissionMode: "approve-reads",
            outputFormatter: NOOP_OUTPUT_FORMATTER,
            waitForCompletion: false,
          });
          assert.equal(outcome, undefined, "the F4 lease did not fall through to a cold spawn");
          assert.equal(await fileFingerprint(lockPath), null);
        }
        assert.equal(remains, !c.reaped, `${c.name}: lease ${remains ? "kept" : "reaped"}`);
      } finally {
        if (server) {
          await closeServer(server);
        }
        stopProcess(keeper);
      }
    });
  }
});

/**
 * T08 (⊗ — d9ab5c0d sees pid alive + start match ⇒ KILLS S, the cross-namespace pid collision) and
 * its positive control T09. S is a live sacrificial process; the lease carries S's REAL start ticks.
 */
for (const foreign of [true, false]) {
  test(
    foreign
      ? "T08 a FOREIGN owner is never signalled"
      : "T09 positive control: the same lease in OUR scope IS signalled",
    async (t) => {
      if (!linux) {
        t.skip("linux identity");
        return;
      }
      await withTempHome(async (homeDir) => {
        const sacrificial = await startKeeperProcess();
        const sessionId = foreign ? "t08-foreign" : "t09-local";
        const lockPath = queueLockFilePath(sessionId, homeDir);
        try {
          const identity = await leaseIdentity(pidOf(sacrificial));
          await writeQueueOwnerLock({
            lockPath,
            pid: sacrificial.pid,
            sessionId,
            socketPath: sharedSocketPath(homeDir, sessionId),
            processIdentity: foreign ? { ...identity, pidNamespace: FOREIGN_NS } : identity,
            host: "dev-server-workbench-x",
          });
          const before = await fileFingerprint(lockPath);
          const startBefore = readProcessBirthIdentity(pidOf(sacrificial));

          const recovered = await recoverQueueOwnerForSession(sessionId);
          if (foreign) {
            assert.equal(recovered.killSkipped, true);
            assert.equal(recovered.skipReason, "foreign-owner");
            assert.equal(recovered.ownerHost, "dev-server-workbench-x");
            assert.equal(recovered.ownerScope, "foreign");
            assert.notEqual(recovered.alive, false);
            assert.deepEqual(await terminateQueueOwnerForSession(sessionId), {
              stopped: false,
              reason: "foreign-owner",
            });
            assert.deepEqual(
              readProcessBirthIdentity(pidOf(sacrificial)),
              startBefore,
              "S was killed",
            );
            assert.equal(await fileFingerprint(lockPath), before, "the foreign lease was touched");
          } else {
            assert.equal(recovered.killSkipped, false);
            assert.equal(recovered.killed, true);
            assert.equal(recovered.alive, false);
            assert.equal(
              await fileFingerprint(lockPath),
              null,
              "the lease was not reaped after the kill",
            );
          }
        } finally {
          stopProcess(sacrificial);
        }
      });
    },
  );
}

/** T12 — the fence, unit level. */
test("T12 fence: refresh of another generation writes nothing; release of another generation or inode unlinks nothing", async () => {
  await withTempHome(async () => {
    const sessionId = "t12-fence";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert.ok(lease);
    const lockPath = lease.lockPath;
    try {
      const stranger: QueueOwnerLease = { ...lease, ownerGeneration: lease.ownerGeneration + 1 };
      const before = await fs.readFile(lockPath, "utf8");
      assert.equal(await refreshQueueOwnerLease(stranger, { queueDepth: 3 }), "superseded");
      assert.equal(await fs.readFile(lockPath, "utf8"), before, "a superseded refresh wrote");

      await fs.mkdir(path.dirname(lease.socketPath), { recursive: true });
      await fs.writeFile(lease.socketPath, "");
      assert.equal(await releaseQueueOwnerLease(stranger, "1:1"), false);
      assert.equal(await fs.readFile(lockPath, "utf8"), before, "a stranger's release unlinked");
      await fs.access(lease.socketPath);

      // ours, but the path holds ANOTHER inode (a successor's socket): lease goes, socket stays
      assert.equal(await releaseQueueOwnerLease(lease, "1:1"), true);
      await assert.rejects(fs.access(lockPath));
      await fs.access(lease.socketPath);
    } finally {
      await fs.rm(lease.socketPath, { force: true });
      await fs.rm(lockPath, { force: true });
    }
  });
});

test("T11 a vanished lease is re-published with the SAME generation", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("t11-republish");
    assert.ok(lease);
    await fs.rm(lease.lockPath);
    assert.equal(await refreshQueueOwnerLease(lease, { queueDepth: 0 }), "republished");
    const record = await readQueueOwnerRecord("t11-republish");
    assert.equal(record?.ownerGeneration, lease.ownerGeneration);
    assert.equal(await releaseQueueOwnerLease(lease), true);
  });
});

/** T12b (⊗ — d9ab5c0d unlinks an empty lease at once, `lease-store.ts:652-656`). */
test("T12b an unparsable lease is removed only once older than 15 s", async () => {
  await withTempHome(async () => {
    const sessionId = "t12b-unparsable";
    const lockPath = queueLockFilePath(sessionId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "");
    const young = new Date(Date.now() - 2_000);
    await fs.utimes(lockPath, young, young);
    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    await fs.access(lockPath); // a pre-0a owner caught mid-`writeFile(wx)` keeps its lease

    const old = new Date(Date.now() - 16_000);
    await fs.utimes(lockPath, old, old);
    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    await assert.rejects(fs.access(lockPath), "a 16 s old unparsable lease was not removed");
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert.ok(lease, "a fresh owner could not acquire after the removal");
    await releaseQueueOwnerLease(lease);
  });
});

/** T13 — the guard. (a) cross-process acquirers over a dead lease; (c) the guard's own holders. */
test("T13a 10 cross-process acquirers over a dead-owner lease ⇒ exactly one owner", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withTempHome(async (homeDir) => {
    const sessionId = "t13-race";
    const child = await startKeeperProcess();
    const identity = await leaseIdentity(pidOf(child));
    stopProcess(child);
    await new Promise((resolve) => child.once("exit", resolve));
    await writeQueueOwnerLock({
      lockPath: queueLockFilePath(sessionId, homeDir),
      pid: child.pid,
      sessionId,
      socketPath: sharedSocketPath(homeDir, sessionId),
      processIdentity: identity,
    });
    const leaseModule = new URL("../src/cli/queue/lease-store.js", import.meta.url).href;
    // A winner HOLDS its lease (stays alive) until every racer has answered: an exited winner's
    // lease is provably dead, and reaping it then is correct — that is not the race under test.
    const script = `
      const m = await import(${JSON.stringify(leaseModule)});
      let won = false;
      for (let i = 0; i < 20 && !won; i += 1) {
        won = Boolean(await m.tryAcquireQueueOwnerLease(${JSON.stringify(sessionId)}));
        if (!won) await new Promise((r) => setTimeout(r, 20));
      }
      process.stdout.write(won ? "won\\n" : "lost\\n");
      if (won) setInterval(() => {}, 1e9);
    `;
    const racers: ChildProcess[] = [];
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () =>
          new Promise<string>((resolve) => {
            const racer = spawn(process.execPath, ["--input-type=module", "-e", script], {
              env: { ...process.env, HOME: homeDir },
              stdio: ["ignore", "pipe", "inherit"],
            });
            racers.push(racer);
            let out = "";
            racer.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString("utf8");
              if (out.includes("\n")) {
                resolve(out.trim());
              }
            });
            racer.once("exit", () => resolve(out.trim()));
          }),
      ),
    );
    for (const racer of racers) {
      racer.kill("SIGKILL");
    }
    assert.equal(results.filter((value) => value === "won").length, 1, results.join(","));
  });
});

test("T13c guard: a dead local holder is broken at once; a young foreign holder blocks the mutation; an old one is broken", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withTempHome(async () => {
    const sessionId = "t13-guard";
    const guardPath = `${queueLockFilePath(sessionId)}.guard`;
    await fs.mkdir(path.dirname(guardPath), { recursive: true });
    const holder = await startKeeperProcess();
    const identity = await leaseIdentity(pidOf(holder));
    stopProcess(holder);
    await new Promise((resolve) => holder.once("exit", resolve));

    await fs.writeFile(guardPath, JSON.stringify({ pid: holder.pid, processIdentity: identity }));
    const startedDead = Date.now();
    assert.equal(await withQueueLeaseMutation(sessionId, async () => "ran"), "ran");
    assert.ok(Date.now() - startedDead < 1_000, "a dead local guard holder was not broken at once");

    const foreignBody = JSON.stringify({
      pid: holder.pid,
      processIdentity: { ...identity, pidNamespace: FOREIGN_NS },
    });
    await fs.writeFile(guardPath, foreignBody);
    await assert.rejects(
      withQueueLeaseMutation(sessionId, async () => "ran"),
      (error: unknown) => (error as { code?: string }).code === "queue-lease-guard-timeout",
    );
    assert.equal(await fs.readFile(guardPath, "utf8"), foreignBody, "young foreign guard broken");

    const old = new Date(Date.now() - 11_000);
    await fs.utimes(guardPath, old, old);
    assert.equal(await withQueueLeaseMutation(sessionId, async () => "ran"), "ran");
  });
});

/** T33 (⊗ — d9ab5c0d's terminate reads the CURRENT lease ⇒ signals S). */
test("T33 close never signals a successor: terminate with the drained generation G1 leaves G2's S alive", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withTempHome(async (homeDir) => {
    const sessionId = "t33-successor";
    const lockPath = queueLockFilePath(sessionId, homeDir);
    const successor = await startKeeperProcess();
    try {
      const socketPath = sharedSocketPath(homeDir, sessionId);
      await writeQueueOwnerLock({ lockPath, pid: 4242, sessionId, socketPath, ownerGeneration: 1 });
      const drained = await readQueueOwnerRecord(sessionId);
      assert.ok(drained);
      // between the drain and the terminate, the lease now names generation 2 — a live successor
      await writeQueueOwnerLock({
        lockPath,
        pid: successor.pid,
        sessionId,
        socketPath,
        ownerGeneration: 2,
        processIdentity: await leaseIdentity(pidOf(successor)),
      });
      assert.deepEqual(await terminateQueueOwnerForSession(sessionId, drained), {
        stopped: false,
        reason: "successor",
      });
      // no lease at the drain (null) and one now ⇒ also a successor
      assert.deepEqual(await terminateQueueOwnerForSession(sessionId, null), {
        stopped: false,
        reason: "successor",
      });
      assert.equal(successor.exitCode, null);
      assert.equal(successor.signalCode, null);
      assert.equal((await readQueueOwnerRecord(sessionId))?.ownerGeneration, 2);
    } finally {
      stopProcess(successor);
    }
  });
});

/** T35 — an unverifiable own scope: every observation `unknown`, nothing signalled or reaped. */
test("T35 /proc self-check failed: recover on a local-looking lease exits killSkipped identity-unverified, reaps nothing", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  await withTempHome(async (homeDir) => {
    const sessionId = "t35-unverified";
    const lockPath = queueLockFilePath(sessionId, homeDir);
    const keeper = await startKeeperProcess();
    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath: sharedSocketPath(homeDir, sessionId),
        processIdentity: await leaseIdentity(pidOf(keeper)),
      });
      const before = await fileFingerprint(lockPath);
      const realFs = await import("node:fs");
      setProcReaderForTests({
        readFile: (file) =>
          file === "/proc/self/stat"
            ? realFs.readFileSync(file, "utf8").replace(/^\d+ /, `${process.pid + 100000} `)
            : realFs.readFileSync(file, "utf8"),
        readLink: (file) => realFs.readlinkSync(file),
      });
      const recovered = await recoverQueueOwnerForSession(sessionId);
      assert.equal(recovered.killSkipped, true);
      assert.equal(recovered.skipReason, "identity-unverified");
      assert.equal(keeper.exitCode, null);
      assert.equal(await fileFingerprint(lockPath), before);
    } finally {
      setProcReaderForTests(undefined);
      stopProcess(keeper);
    }
  });
});

/** T32g — the /proc reader throws: no signal (the matcher's fail-open branch is gone). */
test("T32g signalVerifiedProcess: an unreadable /proc stat refuses the signal", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const keeper = await startKeeperProcess();
  try {
    const identity = readProcessBirthIdentity(pidOf(keeper));
    assert.ok(identity);
    const realFs = await import("node:fs");
    setProcReaderForTests({
      readFile: (file) => {
        if (file === `/proc/${keeper.pid}/stat`) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return realFs.readFileSync(file, "utf8");
      },
      readLink: (file) => realFs.readlinkSync(file),
    });
    assert.equal(signalVerifiedProcess(pidOf(keeper), identity, "SIGTERM"), "refused:unverified");
    setProcReaderForTests(undefined);
    assert.equal(keeper.exitCode, null);
    assert.equal(signalVerifiedProcess(pidOf(keeper), undefined, "SIGTERM"), "refused:no-identity");
  } finally {
    setProcReaderForTests(undefined);
    stopProcess(keeper);
  }
});

/** T36 (⊗ — d9ab5c0d recovers whatever lease is current). */
for (const detailCode of ["QUEUE_OWNER_SHUTTING_DOWN", "MALFORMED"]) {
  test(`T36 the ${detailCode === "MALFORMED" ? "protocol-mismatch" : "shutdown-error"} recovery never signals or reaps a FOREIGN owner`, async (t) => {
    if (!linux) {
      t.skip("linux identity");
      return;
    }
    await withTempHome(async (homeDir) => {
      const sessionId = `t36-${detailCode.toLowerCase()}`;
      const sacrificial = await startKeeperProcess();
      const socketPath = sharedSocketPath(homeDir, sessionId);
      const lockPath = queueLockFilePath(sessionId, homeDir);
      const server = createSingleRequestServer((socket, request) => {
        socket.write(
          detailCode === "MALFORMED"
            ? `${JSON.stringify({ type: "nonsense", requestId: request.requestId })}\n`
            : `${JSON.stringify({
                type: "error",
                requestId: request.requestId,
                code: "RUNTIME",
                detailCode,
                origin: "queue",
                retryable: true,
                message: "owner shutting down",
              })}\n`,
        );
        socket.end();
      });
      try {
        await listenServer(server, socketPath);
        await writeQueueOwnerLock({
          lockPath,
          pid: sacrificial.pid,
          sessionId,
          socketPath,
          processIdentity: await leaseIdentity(pidOf(sacrificial), { pidNamespace: FOREIGN_NS }),
        });
        const before = await fileFingerprint(lockPath);
        await assert.rejects(
          trySubmitToRunningOwner({
            sessionId,
            message: "hello",
            permissionMode: "approve-reads",
            outputFormatter: NOOP_OUTPUT_FORMATTER,
            waitForCompletion: true,
          }),
        );
        assert.equal(sacrificial.exitCode, null, "a foreign owner's pid was signalled");
        assert.equal(sacrificial.signalCode, null, "a foreign owner's pid was signalled");
        assert.equal(await fileFingerprint(lockPath), before, "a foreign lease was touched");
      } finally {
        await closeServer(server);
        stopProcess(sacrificial);
      }
    });
  });
}
