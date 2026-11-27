import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  readQueueOwnerState,
  readQueueOwnerStatus,
  tryAcquireQueueOwnerLease,
  type QueueOwnerLiveness,
} from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import {
  getOwnProcessIdentity,
  getOwnProcessScope,
  serializeProcessBirthIdentity,
  setProcReaderForTests,
  type LinuxProcessScope,
} from "../src/process-identity.js";
import { makeWorld, withEnv, worldEnv, type PodWorld } from "./pod-owner-helpers.js";

// F1 (brick 14901ced, wedge TE F1; architect #28, C3.1). After an IN-PLACE container restart the dead
// owner's queue lease `queues/<key>.lock` carries another pid namespace and a pod-local socket, so row F5
// answered `foreign_owner, alive: null` for ever and every wake failed `retry`. The rule — ALL THREE:
//   1. it is the reader's own pod's lease: an agent pod reads a lease whose `pod` is its own; the CONTROL
//      reads a lease with NO `pod` (only an agent-pod writer adds `pod`, owner-pod.ts leasePodFields);
//   2. both scopes are RECORDED and PARSED and differ (boot / pid ns / time ns); a legacy lease or an
//      unverified own scope stays on F1–F5;
//   3. only where ONE acpx container acts at a time: the control HAS its pod identity (NV_POD_*, the fence
//      is live). Without it a replacement can run beside a LIVE predecessor for ~22 s, so F5 stays.
// ⇒ `dead_owner`, recoverable, deathReason "previous-incarnation".

const linux = process.platform === "linux";
const ID = "rec-f1-previous-incarnation-1";
const STALE = "2026-01-01T00:00:00.000Z";
const OTHER_POD = { name: "ag-other", uid: "77777777-7777-4777-8777-777777777777", node: "n1" };

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid, "spawned a short-lived process");
  return child.pid;
}

function ownScope(): LinuxProcessScope {
  const scope = getOwnProcessScope();
  assert.ok(scope, "this host can read its own scope");
  return scope;
}

const PREVIOUS: Array<[string, () => LinuxProcessScope]> = [
  ["another pid namespace", () => ({ ...ownScope(), pidNamespace: "pid:[4026539999]" })],
  [
    "another boot",
    () => ({ ...ownScope(), bootId: "00000000-0000-4000-8000-000000000000" }),
  ],
  [
    "another pid AND time namespace (what a container restart gives)",
    () => ({ ...ownScope(), pidNamespace: "pid:[4026539999]", timeNamespace: "time:[4026539998]" }),
  ],
];

type Shape = "birth" | "scope-only";

function identityFor(shape: Shape, scope: LinuxProcessScope): Record<string, string> {
  const own = getOwnProcessIdentity();
  assert.equal(own?.kind, "linux-proc");
  const birth = serializeProcessBirthIdentity({ ...(own as object), ...scope } as never);
  if (shape === "birth") {
    return birth;
  }
  return { bootId: scope.bootId, pidNamespace: scope.pidNamespace, timeNamespace: scope.timeNamespace };
}

type LeaseOptions = {
  heartbeatAgeMs?: number;
  socket?: "pod-local" | "shared";
  pod?: unknown;
  identity?: Record<string, string>;
  pid?: number;
};

function plantLease(world: PodWorld, options: LeaseOptions = {}): string {
  const age = options.heartbeatAgeMs ?? 600_000;
  const socketPath =
    options.socket === "shared"
      ? path.join(world.home, ".acpx", "q", "f1.sock")
      : path.join("/tmp", "acpx-f1-podlocal", "f1.sock");
  const body = {
    pid: options.pid ?? deadPid(),
    sessionId: ID,
    socketPath,
    createdAt: STALE,
    heartbeatAt: new Date(Date.now() - age).toISOString(),
    ownerGeneration: 5,
    queueDepth: 0,
    ...(options.identity ? { processIdentity: options.identity } : {}),
    ...(options.pod !== undefined ? { pod: options.pod } : {}),
  };
  const file = queueLockFilePath(ID, world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return fs.readFileSync(file, "utf8");
}

const controlWithIdentity = (world: PodWorld) => worldEnv(world, { place: "control" });
const controlWithoutIdentity = (world: PodWorld) =>
  worldEnv(world, { place: "control", identity: false });
const agentPod = (world: PodWorld) => worldEnv(world, { place: "agent-pod" });

function assertDead(state: QueueOwnerLiveness, where: string): void {
  assert.equal(state.state, "dead_owner", `${where}: dead_owner`);
  assert.equal(state.recoverable, true, `${where}: recoverable`);
  assert.equal(state.alive, false, `${where}: alive false`);
  assert.equal(state.deathReason, "previous-incarnation", `${where}: deathReason`);
}

function assertF5(state: QueueOwnerLiveness, where: string): void {
  assert.equal(state.state, "foreign_owner", `${where}: still foreign_owner (F5)`);
  assert.equal(state.alive, null, `${where}: alive null`);
  assert.equal(state.recoverable, false, `${where}: not recoverable`);
}

// ---- (a) the key rows: the control WITH its pod identity ----

for (const shape of ["birth", "scope-only"] as const) {
  for (const [label, scope] of PREVIOUS) {
    for (const [hb, heartbeatAgeMs] of [
      ["fresh", 1_000],
      ["stale", 600_000],
    ] as const) {
      test(`F1a: control WITH identity, no-pod lease, ${shape} from ${label}, pod-local socket, ${hb} heartbeat ⇒ dead_owner previous-incarnation`, async (t) => {
        if (!linux) {
          t.skip("linux identity");
          return;
        }
        const world = makeWorld(`f1a-${shape}-${hb}`);
        plantLease(world, { heartbeatAgeMs, identity: identityFor(shape, scope()) });
        await withEnv(controlWithIdentity(world), async () => {
          assertDead(await readQueueOwnerState(ID), `${shape}/${label}/${hb}`);
        });
      });
    }
  }
}

test("F1a: a wake takes the session over — the status sweep reaps the lease and tryAcquire gets a new one", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const world = makeWorld("f1a-wake");
  const file = queueLockFilePath(ID, world.home);
  plantLease(world, { heartbeatAgeMs: 1_000, identity: identityFor("birth", PREVIOUS[0][1]()) });
  await withEnv(controlWithIdentity(world), async () => {
    assert.equal(await readQueueOwnerStatus(ID), undefined, "judged dead and reaped");
    assert.equal(fs.existsSync(file), false, "lease unlinked");
    const lease = await tryAcquireQueueOwnerLease(ID);
    assert.ok(lease, "the wake acquired a fresh lease");
  });
});

test("F1a: an agent pod reading its OWN pod's lease from a previous incarnation ⇒ dead_owner (the rule is written for both places)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const world = makeWorld("f1a-agent-own");
  plantLease(world, {
    heartbeatAgeMs: 1_000,
    identity: identityFor("birth", PREVIOUS[0][1]()),
    pod: { name: world.pod.name, uid: world.pod.uid, node: world.pod.node },
  });
  await withEnv(agentPod(world), async () => {
    assertDead(await readQueueOwnerState(ID), "agent pod, own pod");
  });
});

// ---- (b) the negatives: each wrong in exactly what the rule protects ----

test("F1b: the control WITHOUT the pod identity + the SAME lease ⇒ F5 unchanged (a live predecessor may run beside a replacement for ~22 s)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  for (const heartbeatAgeMs of [1_000, 600_000]) {
    const world = makeWorld(`f1b-noid-${heartbeatAgeMs}`);
    plantLease(world, { heartbeatAgeMs, identity: identityFor("birth", PREVIOUS[0][1]()) });
    await withEnv(controlWithoutIdentity(world), async () => {
      const state = await readQueueOwnerState(ID);
      assert.equal(state.state, "foreign_owner", `hb ${heartbeatAgeMs}`);
      assert.equal(state.recoverable, false, `hb ${heartbeatAgeMs}`);
      assert.equal(state.deathReason, undefined);
      if (heartbeatAgeMs > 15_000) {
        assertF5(state, "stale");
      }
    });
  }
});

test("F1b: an UNVERIFIED own scope ⇒ unchanged (every lease stays on the foreign rows)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const world = makeWorld("f1b-unverified");
  plantLease(world, { heartbeatAgeMs: 600_000, identity: identityFor("birth", PREVIOUS[0][1]()) });
  const realFs = await import("node:fs");
  try {
    await withEnv(controlWithIdentity(world), async () => {
      setProcReaderForTests({
        readFile: (file) =>
          file === "/proc/self/stat"
            ? realFs.readFileSync(file, "utf8").replace(/^\d+ /, `${process.pid + 100000} `)
            : realFs.readFileSync(file, "utf8"),
        readLink: (file) => realFs.readlinkSync(file),
      });
      const state = await readQueueOwnerState(ID);
      assertF5(state, "unverified own scope");
      assert.equal(state.deathReason, undefined);
    });
  } finally {
    setProcReaderForTests(undefined);
  }
});

test("F1b: a lease WITH a pod, read on the control ⇒ unchanged (judged as another pod's holder, never previous-incarnation)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const world = makeWorld("f1b-pod-on-control");
  plantLease(world, {
    heartbeatAgeMs: 1_000,
    identity: identityFor("birth", PREVIOUS[0][1]()),
    pod: OTHER_POD,
  });
  await withEnv(controlWithIdentity(world), async () => {
    const state = await readQueueOwnerState(ID);
    assert.equal(state.state, "foreign_owner");
    assert.equal(state.recoverable, false);
    assert.equal(state.deathReason, undefined);
  });
});

test("F1b: an agent pod reading ANOTHER pod's lease ⇒ unchanged; and a pod-less lease ⇒ unchanged (an agent pod never reads the control's lease as its own)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const world = makeWorld("f1b-agent-other");
  plantLease(world, {
    heartbeatAgeMs: 1_000,
    identity: identityFor("birth", PREVIOUS[0][1]()),
    pod: OTHER_POD,
  });
  await withEnv(agentPod(world), async () => {
    const state = await readQueueOwnerState(ID);
    assert.equal(state.state, "foreign_owner");
    assert.equal(state.deathReason, undefined);
  });
  plantLease(world, { heartbeatAgeMs: 600_000, identity: identityFor("birth", PREVIOUS[0][1]()) });
  await withEnv(agentPod(world), async () => {
    assertF5(await readQueueOwnerState(ID), "agent pod, no-pod lease");
  });
});

test("F1b: the SAME scope + a LIVE owner ⇒ not dead (control with identity)", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const world = makeWorld("f1b-live");
  plantLease(world, {
    heartbeatAgeMs: 1_000,
    pid: process.pid,
    identity: identityFor("birth", ownScope()),
  });
  await withEnv(controlWithIdentity(world), async () => {
    const state = await readQueueOwnerState(ID);
    assert.notEqual(state.state, "dead_owner");
    assert.notEqual(state.alive, false);
    assert.equal(state.recoverable, false);
    assert.equal(state.deathReason, undefined);
  });
});

test("F1b: a LEGACY lease (no scope at all) ⇒ today's rule, identical with and without the identity", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const seen: unknown[] = [];
  for (const [label, envOf] of [
    ["with identity", controlWithIdentity],
    ["without identity", controlWithoutIdentity],
  ] as const) {
    const world = makeWorld(`f1b-legacy-${label.replace(/\W/g, "")}`);
    plantLease(world, { heartbeatAgeMs: 600_000, pid: process.pid });
    await withEnv(envOf(world), async () => {
      const state = await readQueueOwnerState(ID);
      assert.notEqual(state.deathReason, "previous-incarnation", label);
      seen.push([state.state, state.alive, state.recoverable, state.scope]);
    });
  }
  assert.deepEqual(seen[0], seen[1], "the identity changes nothing for a legacy lease");
});

// ---- (b) F-rows unchanged for a truly foreign scope WITHOUT the rule's conditions (control, no identity) ----

test("F1b: F1 / F4 / F5 unchanged — control without identity, a foreign-namespace no-pod lease", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const rows: Array<[string, LeaseOptions, string, boolean | null]> = [
    ["F1 fresh heartbeat", { heartbeatAgeMs: 1_000 }, "foreign_owner", true],
    ["F4 31 s, shared path, no listener", { heartbeatAgeMs: 31_000, socket: "shared" }, "dead_owner", false],
    ["F5 10 min, pod-local socket", { heartbeatAgeMs: 600_000 }, "foreign_owner", null],
  ];
  for (const [name, options, state, alive] of rows) {
    const world = makeWorld(`f1b-${name.slice(0, 2)}`);
    plantLease(world, { ...options, identity: identityFor("birth", PREVIOUS[0][1]()) });
    await withEnv(controlWithoutIdentity(world), async () => {
      const got = await readQueueOwnerState(ID);
      assert.deepEqual([got.state, got.alive], [state, alive], name);
      assert.notEqual(got.deathReason, "previous-incarnation", name);
    });
  }
});
