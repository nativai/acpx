import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { reapTranscriptsAfterClose } from "../src/cli/session/owner-exit-transcript-reap.js";
import { appendClearedBackgroundTasksLine } from "../src/cli/session/owner-task-reap.js";
import { getPerfMetricsSnapshot, resetPerfMetrics } from "../src/perf-metrics.js";
import { sessionKey } from "../src/pod/placement.js";
import {
  getOwnProcessScope,
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import {
  sessionBaseDir,
  sessionEventActivePath,
  sessionEventLockPath,
} from "../src/session/event-log.js";
import {
  acquireEventsLock,
  appendStreamText,
  appendStreamTextSync,
  SessionEventWriter,
} from "../src/session/events.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { judgeLockHolder } from "../src/session/persistence/identity-file-lock.js";
import { startFakeApiServer, type ApiScript } from "./pod-kit/fake-apiserver.js";
import { KIT_NAMESPACE } from "./pod-kit/two-pods.js";
import {
  agentPodNameFor,
  makeWorld,
  withEnv,
  worldEnv,
  type PodWorld,
} from "./pod-owner-helpers.js";
import { writeLeaseWithBadPod, writePodLease } from "./pod-proof-helpers.js";
import { frame, record } from "./stream-appender-kit.js";
import { writeRecordFixture, writeRegistry } from "./transcript-fixture-test-helpers.js";

// A-80 (bricks ce139c8a + 766c4dd7): rows 80.1 and 80.3 of TEST-PLAN-ROWS-A29-A36.md.
//
// 80.1 — while a session's pod exists, a CONTROL-ROLE host appends nothing to the session's stream or owner
// log: C3.3 (the API server, WITH the node check) must prove the pod gone first; otherwise the line goes to
// `<id>.markers.ndjson` in C5's format and is logged `pod_foreign_write`. 80.3 — a lock body without `pod`
// from another boot is unjudgeable, never breakable (C3.2 row 3).
//
// The control pod is a process standing in `ACPX_POD_TEST_HOME` with `NV_POD_*` and pod mode on; the session's
// pod is a second identity whose lease sits in the same state home; the API server is the kit's fake.

const SEED_STREAM_LINE = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 0 } })}\n`;
const COUNTER = "session.pod_foreign_write";
const PRINT_BYTES = 4096;

type Proof =
  | "exists"
  | "terminal"
  | "gone"
  | "node-not-ready"
  | "api-down"
  | "unreadable-lease"
  | "no-lease"
  | "lease-without-pod";

/** The cases where the control pod may NOT write: C3.3 did not say `gone`, or there is nothing to prove it against. */
const DIVERTED: Proof[] = ["exists", "node-not-ready", "api-down", "unreadable-lease"];
/** The cases where it may: the pod is proven gone (a node that is Ready or absent; or a terminal phase). */
const PROVEN_GONE: Proof[] = ["gone", "terminal"];
/** The cases that are not a pod session at all: today's behaviour, the sidecar stays empty. */
const NOT_A_POD_SESSION: Proof[] = ["no-lease", "lease-without-pod"];

type Case = { ctl: PodWorld; pod: PodWorld; proof: Proof; env: Record<string, string | undefined> };

function apiScriptFor(proof: Proof, pod: PodWorld): ApiScript {
  const seed = {
    name: pod.pod.name,
    namespace: KIT_NAMESPACE,
    uid: pod.pod.uid,
    node: pod.pod.node,
  };
  const nodeReady = { name: pod.pod.node, ready: "True" as const };
  switch (proof) {
    case "terminal":
      return { pods: [{ ...seed, phase: "Failed" }], nodes: [nodeReady] };
    case "gone":
      return { pods: [], nodes: [nodeReady] };
    case "node-not-ready":
      // The label lookup would call this pod absent. C3.3 without a Ready node says `unknown` (a force-deleted pod
      // on a partitioned node can still run its processes): the node check is what this case holds.
      return { pods: [], nodes: [{ name: pod.pod.node, ready: "False" as const }] };
    default:
      return { pods: [seed], nodes: [nodeReady] };
  }
}

async function withCase(proof: Proof, run: (c: Case) => Promise<void>): Promise<void> {
  const ctl = makeWorld("a80c");
  const podBase = makeWorld("a80p");
  const pod: PodWorld = { ...podBase, home: ctl.home };
  const api = await startFakeApiServer(apiScriptFor(proof, pod));
  const apiUrl = api.url;
  if (proof === "api-down") {
    await api.close();
  }
  const env = worldEnv(ctl, {
    podMode: true,
    extra: {
      ACPX_POD_API_URL: apiUrl,
      HOME: ctl.home,
      ACPX_TEST_STREAM_APPEND_STALL_MS: "40",
      ACPX_TEST_STREAM_APPEND_DEADLINE_MS: "300",
    },
  });
  try {
    await withEnv(env, async () => await run({ ctl, pod, proof, env }));
  } finally {
    if (proof !== "api-down") {
      await api.close();
    }
    fs.rmSync(ctl.root, { recursive: true, force: true });
    fs.rmSync(podBase.root, { recursive: true, force: true });
  }
}

function ownerLogPath(sid: string): string {
  return path.join(sessionBaseDir(), `${encodeURIComponent(sid)}.owner.log`);
}

function sidecarPath(sid: string): string {
  return path.join(sessionBaseDir(), `${encodeURIComponent(sid)}.markers.ndjson`);
}

/** The lease (or its absence) and the files a pod's owner would have left: a stream with a line, an owner log. */
async function seedSession(
  c: Case,
  sid: string,
  options: { partialTail?: boolean } = {},
): Promise<void> {
  fs.mkdirSync(sessionBaseDir(), { recursive: true });
  fs.writeFileSync(
    sessionEventActivePath(sid),
    options.partialTail ? `${SEED_STREAM_LINE}{"jsonrpc":"2.0","method":"sess` : SEED_STREAM_LINE,
  );
  fs.writeFileSync(ownerLogPath(sid), "owner line 1\n");
  if (c.proof === "unreadable-lease") {
    await writeLeaseWithBadPod(c.pod, sid, "ag-not-an-object");
  } else if (c.proof === "no-lease") {
    // nothing: a home session on the control pod
  } else if (c.proof === "lease-without-pod") {
    const { tryAcquireQueueOwnerLease } = await import("../src/cli/queue/lease-store.js");
    assert(await tryAcquireQueueOwnerLease(sid)); // written on the control pod, no pod identity in the body path under test
    stripPod(sid);
  } else {
    await writePodLease(c.pod, sid);
  }
  if (options.partialTail) {
    // The pod's owner is mid-line under ITS stream lock (a body that names the pod).
    fs.writeFileSync(
      sessionEventLockPath(sid),
      JSON.stringify({ pid: 4242, host: "pod", pod: c.pod.pod, token: "pod-owner-token" }),
    );
  }
}

function stripPod(sid: string): void {
  const file = path.join(process.env.ACPX_STATE_HOME ?? "", ".acpx", "queues");
  for (const name of fs.readdirSync(file)) {
    const full = path.join(file, name);
    const body = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
    if (body.sessionId === sid) {
      delete body.pod;
      fs.writeFileSync(full, JSON.stringify(body));
    }
  }
}

type Snap = { bytes: string; ino: number; size: number; owner: string; lock: string | null };

function snap(sid: string): Snap {
  const active = sessionEventActivePath(sid);
  const st = fs.statSync(active);
  const lock = sessionEventLockPath(sid);
  return {
    bytes: fs.readFileSync(active, "utf8"),
    ino: st.ino,
    size: st.size,
    owner: fs.readFileSync(ownerLogPath(sid), "utf8"),
    lock: fs.existsSync(lock) ? fs.readFileSync(lock, "utf8") : null,
  };
}

function printOf(bytes: Buffer): string {
  const head = bytes.subarray(0, Math.min(PRINT_BYTES, bytes.length));
  return `${head.length}:${createHash("sha256").update(head).digest("hex").slice(0, 24)}`;
}

type SidecarLine = {
  v: number;
  ts: string;
  offset: number;
  ino?: number;
  fp?: string;
  marker: { jsonrpc: string; method: string; params: Record<string, unknown> };
};

function sidecarLines(sid: string): SidecarLine[] {
  const file = sidecarPath(sid);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SidecarLine);
}

/** C5's line, key for key, with the position triple measured on the stream as it was at the diversion. */
function assertC5Line(line: SidecarLine, before: Snap, method: string, why: string): void {
  assert.deepEqual(Object.keys(line).toSorted(), ["fp", "ino", "marker", "offset", "ts", "v"], why);
  assert.equal(line.v, 1, why);
  assert.ok(Number.isFinite(Date.parse(line.ts)), `${why}: ts is an ISO time`);
  assert.equal(line.offset, before.size, `${why}: offset is the active stream's size`);
  assert.equal(line.ino, before.ino, `${why}: ino is the active stream's inode`);
  assert.equal(
    line.fp,
    printOf(Buffer.from(before.bytes, "utf8")),
    `${why}: fp is the content print`,
  );
  assert.equal(line.marker.jsonrpc, "2.0", why);
  assert.equal(line.marker.method, method, why);
}

type ControlPath = {
  name: string;
  target: "stream" | "owner-log";
  /** The marker method the diverted line carries. */
  method: string;
  /** Needs the pod's owner mid-line under its stream lock (the forced-end path). */
  partialTail?: boolean;
  /** A synchronous caller cannot ask the API: it never proves `gone` (DESIGN §3), so it diverts there too. */
  syncNoProof?: boolean;
  /** Not runnable inside an agent pod (it needs the control pod's record store). */
  controlOnly?: boolean;
  run: (c: Case, sid: string) => Promise<void>;
};

const RECEIVED_LINE = `${JSON.stringify({ jsonrpc: "2.0", method: "acpx/received", params: { n: 2 } })}\n`;
const FORCED_END_LINE = `${JSON.stringify({ jsonrpc: "2.0", method: "acpx/refused", params: { n: 3 } })}\n`;

const CONTROL_PATHS: ControlPath[] = [
  {
    name: "sessions recover / set after a routed call found no pod: the cleared-background-tasks line (async helper)",
    target: "stream",
    method: "_claude/backgroundTasks",
    run: async (_c, sid) => await appendClearedBackgroundTasksLine(sid, "acp-80"),
  },
  {
    name: "the sync helper (an exit path's terminal)",
    target: "stream",
    method: "acpx/received",
    syncNoProof: true,
    run: async (_c, sid) => {
      appendStreamTextSync(sid, RECEIVED_LINE);
    },
  },
  {
    name: "a SessionEventWriter on the control pod: the flows' direct send (runtime.ts:709, sendSessionDirect)",
    target: "stream",
    method: "session/update",
    run: async (c, sid) => {
      await writeSessionRecord(record(sid, c.ctl.home));
      const writer = await SessionEventWriter.open(record(sid, c.ctl.home));
      await writer.appendMessage(frame(1));
      await writer.close();
    },
  },
  {
    name: "sessions close after the broker's `deleted`: the owner-log line (owner-exit-transcript-reap)",
    target: "owner-log",
    method: "acpx/owner_log",
    controlOnly: true,
    run: async (c, sid) => {
      await writeRegistry(c.ctl.home, ["subA", "subB"], "subA");
      await writeRecordFixture(c.ctl.home, {
        recordId: sid,
        acpSessionId: `acp-${sid}`,
        cwd: "/work/a80",
        profile: "subB",
      });
      const outcome = await reapTranscriptsAfterClose(
        {
          sessionId: sid,
          closeStartedAt: Date.now(),
          observation: { pid: 424242, identity: { kind: "timestamp" } as never, groupLeader: true },
          ownerStop: { stopped: true, reason: "stopped" },
          adapter: { pid: undefined, pidIdentity: undefined },
          recordClosedState: { status: "read", closed: { present: true, value: true } },
        },
        { hasLeftBehind: async () => true },
      );
      // A session that is not in a pod proceeds to the next proof (the owner it observed is "alive"); either way a line is emitted.
      assert.deepEqual(outcome, {
        ran: false,
        reason: NOT_A_POD_SESSION.includes(c.proof) ? "owner-alive" : "not-local-proof",
      });
    },
  },
  {
    name: "a forced end (A-66) from outside the pod, after the stall bound",
    target: "stream",
    method: "acpx/refused",
    partialTail: true,
    run: async (_c, sid) => await appendStreamText(sid, FORCED_END_LINE),
  },
];

function captureStderr(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const spy = mock.method(process.stderr, "write", (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  return { lines: () => written, restore: () => spy.mock.restore() };
}

function foreignWriteLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes("pod_foreign_write"));
}

test("80.1 the pod exists, or C3.3 cannot say `gone`: the control pod writes NOTHING into the stream or owner log; each line is in the sidecar in C5's format, logged pod_foreign_write and counted", async () => {
  for (const proof of DIVERTED) {
    await withCase(proof, async (c) => {
      resetPerfMetrics();
      let diverted = 0;
      for (const [index, controlPath] of CONTROL_PATHS.entries()) {
        const sid = `a80-div-${proof}-${index}`;
        const why = `${proof} / ${controlPath.name}`;
        await seedSession(c, sid, { partialTail: controlPath.partialTail });
        const before = snap(sid);
        const stderr = captureStderr();
        try {
          await controlPath.run(c, sid);
        } finally {
          stderr.restore();
        }
        const after = snap(sid);
        assert.deepEqual(
          after,
          before,
          `${why}: the stream (size, inode, bytes), its lock and the owner log are untouched`,
        );
        const lines = sidecarLines(sid);
        assert.equal(lines.length, 1, `${why}: exactly one line in ${sidecarPath(sid)}`);
        assertC5Line(lines[0], before, controlPath.method, why);
        assert.equal(
          foreignWriteLines(stderr.lines()).length,
          1,
          `${why}: one pod_foreign_write line`,
        );
        diverted += 1;
      }
      assert.equal(
        getPerfMetricsSnapshot().counters[COUNTER],
        diverted,
        `${proof}: every diversion is counted`,
      );
    });
  }
});

test("80.1 the pod is proven GONE by C3.3 (no pod and the node Ready, or a terminal phase): the same paths write the stream and the owner log, the sidecar stays empty", async () => {
  for (const proof of PROVEN_GONE) {
    await withCase(proof, async (c) => {
      resetPerfMetrics();
      for (const [index, controlPath] of CONTROL_PATHS.entries()) {
        const sid = `a80-gone-${proof}-${index}`;
        const why = `${proof} / ${controlPath.name}`;
        await seedSession(c, sid, { partialTail: controlPath.partialTail });
        const before = snap(sid);
        const stderr = captureStderr();
        try {
          await controlPath.run(c, sid);
        } finally {
          stderr.restore();
        }
        const after = snap(sid);
        if (controlPath.syncNoProof === true) {
          assert.deepEqual(
            after.bytes,
            before.bytes,
            `${why}: a sync caller cannot prove death, so it diverts even here`,
          );
          assert.equal(sidecarLines(sid).length, 1, why);
          continue;
        }
        if (controlPath.target === "stream") {
          assert.ok(after.bytes.length > before.bytes.length, `${why}: the line is in the stream`);
        } else {
          assert.ok(
            after.owner.length > before.owner.length,
            `${why}: the line is in the owner log`,
          );
        }
        assert.equal(sidecarLines(sid).length, 0, `${why}: nothing was diverted`);
        assert.equal(
          foreignWriteLines(stderr.lines()).length,
          0,
          `${why}: no pod_foreign_write line`,
        );
      }
    });
  }
});

test("80.1 the sidecar stays EMPTY on every correct path: no lease, a lease without `pod`, the pod's own owner, a host that is not control-role", async () => {
  for (const proof of NOT_A_POD_SESSION) {
    await withCase(proof, async (c) => {
      for (const [index, controlPath] of CONTROL_PATHS.entries()) {
        const sid = `a80-home-${proof}-${index}`;
        await seedSession(c, sid, { partialTail: false });
        const before = snap(sid);
        await controlPath.run(c, sid);
        assert.equal(sidecarLines(sid).length, 0, `${proof} / ${controlPath.name}: sidecar empty`);
        assert.notDeepEqual(
          snap(sid),
          before,
          `${proof} / ${controlPath.name}: the line is where it always was`,
        );
      }
    });
  }
  // The pod's own owner: an agent pod named for the session writes its own stream at once (no proof asked).
  const sid = "a80-own-pod-session";
  const world = makeWorld("a80o", { podName: agentPodNameFor(sessionKey(sid)) });
  const env = worldEnv(world, { place: "agent-pod", podMode: true, extra: { HOME: world.home } });
  try {
    await withEnv(env, async () => {
      fs.mkdirSync(sessionBaseDir(), { recursive: true });
      fs.writeFileSync(sessionEventActivePath(sid), SEED_STREAM_LINE);
      await appendStreamText(sid, RECEIVED_LINE);
      appendStreamTextSync(sid, RECEIVED_LINE);
      await appendClearedBackgroundTasksLine(sid, "acp-own");
      assert.equal(fs.readFileSync(sessionEventActivePath(sid), "utf8").split("\n").length, 5);
      assert.equal(fs.existsSync(sidecarPath(sid)), false, "in the pod: no sidecar");
    });
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
  // A host that is not control-role (a workbench, a rig) keeps today's behaviour: the guard is for the control pod.
  await withCase("exists", async (c) => {
    const rig = { ...c.env, ACPX_POD_TEST_HOME: undefined, ACPX_OWNER_PLACEMENT: undefined };
    const rigSid = "a80-rig-session";
    await seedSession(c, rigSid);
    await withEnv(rig, async () => {
      await appendStreamText(rigSid, RECEIVED_LINE);
    });
    assert.equal(fs.existsSync(sidecarPath(rigSid)), false, "not control-role: no sidecar");
    assert.ok(fs.readFileSync(sessionEventActivePath(rigSid), "utf8").includes("acpx/received"));
  });
});

// ---- 80.3: a body without `pod` from another boot ----------------------------------------------------------

const OTHER_BOOT = "00000000-0000-4000-8000-0000000000a8";

/** A lock body without `pod`, its holder (this very process) ALIVE, written on another boot of "another machine". */
function otherBootBody(pid: number = process.pid): Record<string, unknown> {
  const own = getOwnProcessScope();
  const identity = readProcessBirthIdentity(pid);
  assert.ok(own && identity, "this test host can read its own birth identity");
  return {
    pid,
    host: "machine-a",
    created_at: new Date().toISOString(),
    processIdentity: { ...serializeProcessBirthIdentity(identity), bootId: OTHER_BOOT },
  };
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(child.pid !== undefined);
  return child.pid;
}

test("80.3 judge: a body without `pod` whose boot id differs from the reader's is unjudgeable, never breakable — the holder alive on machine A, read on machine B", async () => {
  const world = makeWorld("a80j");
  try {
    await withEnv(worldEnv(world, { podMode: false, identity: false }), async () => {
      assert.equal(judgeLockHolder(otherBootBody()), "unjudgeable");
    });
    await withEnv(worldEnv(world, { place: "agent-pod", podMode: true }), async () => {
      assert.equal(judgeLockHolder(otherBootBody()), "unjudgeable");
    });
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
});

test("80.3 pairs: the same boot with the process gone is breakable at once; in an agent pod a no-pod body is never breakable at all", async () => {
  const world = makeWorld("a80k");
  try {
    const own = getOwnProcessScope();
    assert.ok(own);
    const dead = deadPid();
    const sameBootDead = {
      pid: dead,
      host: "this-machine",
      processIdentity: {
        kind: "linux-proc-stat-starttime",
        startTimeTicks: "1",
        bootId: own.bootId,
        pidNamespace: own.pidNamespace,
        timeNamespace: own.timeNamespace,
      },
    };
    await withEnv(worldEnv(world, { podMode: false, identity: false }), async () => {
      assert.equal(
        judgeLockHolder(sameBootDead),
        "breakable",
        "control host, same boot, dead pid: as today",
      );
    });
    await withEnv(worldEnv(world, { place: "agent-pod", podMode: true }), async () => {
      assert.notEqual(
        judgeLockHolder(sameBootDead),
        "breakable",
        "an agent pod does not judge a body without `pod` (C3.2 row 3): the stream appender's dead-writer test reads this",
      );
    });
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
});

test("80.3 the stream lock: on the control pod a no-pod body from another boot is not taken inside the stale age (red today: taken at once), and in an agent pod never", async () => {
  const world = makeWorld("a80l");
  try {
    await withEnv(worldEnv(world, { podMode: true, extra: { HOME: world.home } }), async () => {
      const sid = "a80-lock-control";
      fs.mkdirSync(sessionBaseDir(), { recursive: true });
      const body = JSON.stringify(otherBootBody());
      fs.writeFileSync(sessionEventLockPath(sid), body);
      await assert.rejects(
        async () => await acquireEventsLock(sid, 1_200),
        (error: { code?: string }) => error.code === "stream-lock-timeout",
        "not taken inside the stale age",
      );
      assert.equal(
        fs.readFileSync(sessionEventLockPath(sid), "utf8"),
        body,
        "the holder's lock is untouched",
      );
      // Past the stale age the control pod may break it (by AGE, the unjudgeable row) — the rule is not "never".
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(sessionEventLockPath(sid), old, old);
      const stderr = captureStderr();
      try {
        const lock = await acquireEventsLock(sid, 5_000);
        assert.notEqual(fs.readFileSync(sessionEventLockPath(sid), "utf8"), body);
        assert.ok(lock.content.length > 0);
      } finally {
        stderr.restore();
      }
      assert.ok(stderr.lines().some((line) => line.includes("broke stale session stream lock")));
    });
    await withEnv(
      worldEnv(world, { place: "agent-pod", podMode: true, extra: { HOME: world.home } }),
      async () => {
        const sid = "a80-lock-agent";
        const body = JSON.stringify(otherBootBody());
        fs.writeFileSync(sessionEventLockPath(sid), body);
        const old = new Date(Date.now() - 10 * 60_000);
        fs.utimesSync(sessionEventLockPath(sid), old, old);
        await assert.rejects(
          async () => await acquireEventsLock(sid, 1_200),
          (error: { code?: string }) => error.code === "stream-lock-timeout",
          "an agent pod never breaks it, whatever its age",
        );
        assert.equal(fs.readFileSync(sessionEventLockPath(sid), "utf8"), body);
      },
    );
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
});

test("80.3 the stream appender's dead-writer test: at a partial line under a no-pod body from another boot it WAITS to the bound instead of writing into the line", async () => {
  const world = makeWorld("a80w");
  try {
    for (const place of ["control", "agent-pod"] as const) {
      await withEnv(
        worldEnv(world, {
          place,
          podMode: place === "agent-pod",
          identity: place === "agent-pod",
          extra: { HOME: world.home, ACPX_TEST_STREAM_APPEND_STALL_MS: "300" },
        }),
        async () => {
          const sid = `a80-wait-${place}`;
          fs.mkdirSync(sessionBaseDir(), { recursive: true });
          fs.writeFileSync(
            sessionEventActivePath(sid),
            `${SEED_STREAM_LINE}{"jsonrpc":"2.0","method":"sess`,
          );
          fs.writeFileSync(sessionEventLockPath(sid), JSON.stringify(otherBootBody()));
          const stderr = captureStderr();
          const started = Date.now();
          try {
            appendStreamTextSync(sid, RECEIVED_LINE);
          } finally {
            stderr.restore();
          }
          assert.ok(
            Date.now() - started >= 250,
            `${place}: the appender waited (${Date.now() - started} ms) — a body from another boot is no proof its writer is dead`,
          );
          assert.ok(
            stderr.lines().some((line) => line.includes("ended a live writer's line")),
            `${place}: it then ended the line at the bound and said so (A-66), never silently`,
          );
        },
      );
    }
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
});
