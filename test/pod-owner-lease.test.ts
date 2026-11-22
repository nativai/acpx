import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  matchesQueueOwner,
  readQueueOwnerRecord,
  readQueueOwnerState,
  tryAcquireQueueOwnerLease,
  type QueueOwnerRecord,
} from "../src/cli/queue/lease-store.js";
import { queueLockFilePath, queueSharedSocketDir } from "../src/cli/queue/paths.js";
import { LEASE_ROUTED_CONTRACT, leasePodFields, podSocketPath } from "../src/pod/owner-pod.js";
import { sessionKey } from "../src/pod/placement.js";
import { ROUTED_CONTRACT_VERSION } from "../src/pod/routed-call.js";
import { makePod } from "./pod-kit/two-pods.js";
import { startFakeApi } from "./pod-lock-fake-api.js";
import { makeWorld, withEnv, worldEnv, writePlaceFile } from "./pod-owner-helpers.js";

// Block A4 (brick 30df3a5b), C3.1: the lease's pod fields, the pod-local socket, the judging of a lease
// that names a pod (C3.3). Every probe runs in a sandbox state home (`ACPX_STATE_HOME` = the world's
// stand-in `/home/node`), never the box's real `~/.acpx`.

const RELEASES = JSON.stringify({ acpx: "rel-2026-11-22-abc", pi: "pi-1" });

test("the lease's pod contract constant is the C2 version the routed call speaks", () => {
  assert.equal(LEASE_ROUTED_CONTRACT, ROUTED_CONTRACT_VERSION);
});

test("an owner in an agent pod writes the full C3.1 field set and a pod-local socket", async () => {
  const world = makeWorld("lease-a");
  const env = worldEnv(world, {
    place: "agent-pod",
    podMode: true,
    extra: { NV_AGENT_PLACEMENT: "home", NV_RUNTIME_RELEASES: RELEASES },
  });
  await withEnv(env, async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-session-a");
    assert(lease);
    const record = await readQueueOwnerRecord("lease-session-a");
    assert.deepEqual(record?.pod, world.pod);
    assert.equal(record?.placement, "home");
    assert.equal(record?.routedContract, 1);
    assert.equal(record?.acpxRelease, "rel-2026-11-22-abc");
    const expected = path.join(
      world.home,
      "run",
      "acpx",
      "q",
      `${sessionKey("lease-session-a")}.sock`,
    );
    assert.equal(record?.socketPath, expected);
    assert.ok(fs.statSync(path.dirname(expected)).isDirectory(), "the pod-local directory exists");
    // Outside the shared `q/` directory: never judged by a connect (C3.1).
    assert.ok(!record?.socketPath.startsWith(queueSharedSocketDir(world.home)));
  });
});

test("placement and release come through the pod facts: PID 1's stand-in answers where the process lacks them", async () => {
  const world = makeWorld("lease-pid1");
  const standIn = path.join(world.root, "pid1.environ");
  fs.writeFileSync(
    standIn,
    [`NV_AGENT_PLACEMENT=pool`, `NV_RUNTIME_RELEASES=${RELEASES}`].join("\0") + "\0",
  );
  const env = worldEnv(world, {
    place: "agent-pod",
    extra: { ACPX_POD_TEST_PID1_ENVIRON: standIn },
  });
  await withEnv(env, () => {
    const fields = leasePodFields();
    assert.equal(fields?.placement, "pool");
    assert.equal(fields?.acpxRelease, "rel-2026-11-22-abc");
  });
});

test("a placement that is neither pool nor home, and a release object without acpx, are not written", async () => {
  const world = makeWorld("lease-odd");
  const env = worldEnv(world, {
    place: "agent-pod",
    extra: { NV_AGENT_PLACEMENT: "elsewhere", NV_RUNTIME_RELEASES: JSON.stringify({ pi: "x" }) },
  });
  await withEnv(env, () => {
    const fields = leasePodFields();
    assert.equal(fields?.placement, undefined);
    assert.equal(fields?.acpxRelease, undefined);
    assert.equal(fields?.routedContract, 1);
  });
});

test("A-25 negative: an agent pod that cannot name its pod takes no lease and creates no file", async () => {
  for (const missing of ["NV_POD_UID", "NV_NODE_NAME", "NV_POD_NAME"] as const) {
    const world = makeWorld(`lease-noid-${missing.toLowerCase()}`);
    const env = worldEnv(world, { place: "agent-pod", podMode: true, identity: true });
    env[missing] = undefined;
    await withEnv(env, async () => {
      assert.throws(() => leasePodFields(), { code: "pod_identity_missing" });
      await assert.rejects(tryAcquireQueueOwnerLease("lease-no-identity"), {
        code: "pod_identity_missing",
      });
      assert.equal(fs.existsSync(queueLockFilePath("lease-no-identity")), false);
    });
  }
});

test("A-25 holds for any state home and without the switch, and the hostname is a second witness", async () => {
  const world = makeWorld("lease-witness");
  // No place file at all, only the kernel hostname `ag-…` (A-28), no switch, no identity.
  const env = worldEnv(world, {
    identity: false,
    extra: { ACPX_POD_TEST_HOSTNAME: "ag-0123456789abcdef01234567" },
  });
  await withEnv(env, () => {
    assert.throws(() => leasePodFields(), { code: "pod_identity_missing" });
  });
  // The same host, now able to name its pod: the lease names it (place-missing is the placement step's refusal, not the writer's).
  const named = worldEnv(world, {
    extra: { ACPX_POD_TEST_HOSTNAME: "ag-0123456789abcdef01234567" },
  });
  await withEnv(named, () => {
    assert.deepEqual(leasePodFields()?.pod, world.pod);
  });
});

test("negative: the control pod and a plain host write today's lease — no pod field, today's socket", async () => {
  const world = makeWorld("lease-control");
  const env = worldEnv(world, { place: "control", podMode: false });
  await withEnv(env, async () => {
    assert.equal(leasePodFields(), undefined);
    assert.equal(podSocketPath("lease-control-session", 107), undefined);
    const lease = await tryAcquireQueueOwnerLease("lease-control-session");
    assert(lease);
    const onDisk = JSON.parse(fs.readFileSync(queueLockFilePath("lease-control-session"), "utf8"));
    for (const field of ["pod", "placement", "routedContract", "acpxRelease"]) {
      assert.equal(field in onDisk, false, `${field} is not written outside an agent pod`);
    }
    assert.ok(lease.socketPath.startsWith(queueSharedSocketDir(world.home)));
  });
});

test("the seam is explicit: an EMPTY NODE_TEST_CONTEXT honours no seam, so no agent pod is declared", async () => {
  const world = makeWorld("lease-seam");
  writePlaceFile(world, `${world.pod.name}\n`);
  const env = worldEnv(world, { place: "agent-pod" });
  env.NODE_TEST_CONTEXT = "";
  await withEnv(env, () => {
    // The seam's directory is not read, so the stand-in `.nv-agent` declares nothing here; this box's
    // real place decides, and it is not an agent pod in a test run.
    assert.equal(leasePodFields(), undefined);
  });
});

test("a socket path longer than a unix socket may be is refused, never truncated", async () => {
  const world = makeWorld("lease-long");
  await withEnv(worldEnv(world, { place: "agent-pod" }), () => {
    assert.throws(() => podSocketPath("long-path-session", 20), /longer than 20 bytes/);
  });
});

test("the heartbeat fence names the pod: a record of another pod with the same pid and generation is not ours", () => {
  const mine = makePod("fence-a");
  const other = makePod("fence-b");
  const base: QueueOwnerRecord = {
    pid: process.pid,
    sessionId: "fence-session",
    socketPath: "/run/acpx/q/x.sock",
    createdAt: "2026-11-22T00:00:00.000Z",
    heartbeatAt: "2026-11-22T00:00:00.000Z",
    ownerGeneration: 7,
    queueDepth: 0,
  };
  const lease = { sessionId: "fence-session", ownerGeneration: 7, pod: mine };
  assert.equal(matchesQueueOwner(lease, { ...base, pod: mine }), true);
  assert.equal(matchesQueueOwner(lease, { ...base, pod: other }), false);
  // A record without `pod` (a pre-A4 lease) still matches by generation and pid, as today.
  assert.equal(matchesQueueOwner(lease, base), true);
  assert.equal(matchesQueueOwner({ ...lease, pod: undefined }, { ...base, pod: other }), true);
});

// ---------------------------------------------------------------------------------------------
// Judging a lease that names a pod (C3.1, C3.3)
// ---------------------------------------------------------------------------------------------

const STALE = "2026-01-01T00:00:00.000Z";

/** Acquire a lease as `world`'s agent pod, then age its heartbeat (or leave it fresh). */
async function leaseFromPod(
  world: ReturnType<typeof makeWorld>,
  sessionId: string,
  heartbeatAt?: string,
): Promise<void> {
  const env = worldEnv(world, { place: "agent-pod", podMode: true });
  await withEnv(env, async () => {
    assert(await tryAcquireQueueOwnerLease(sessionId));
    if (heartbeatAt) {
      const file = queueLockFilePath(sessionId);
      const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(file, `${JSON.stringify({ ...lease, heartbeatAt })}\n`);
    }
  });
}

type Reader = "control" | "other-pod";

function readerEnv(
  owner: ReturnType<typeof makeWorld>,
  reader: Reader,
  apiUrl: string | undefined,
): Record<string, string | undefined> {
  if (reader === "control") {
    const world = makeWorld("reader-control");
    return worldEnv(world, {
      place: "control",
      identity: false,
      extra: {
        ACPX_STATE_HOME: owner.home,
        ACPX_POD_SA_DIR: owner.saDir,
        ACPX_POD_API_URL: apiUrl,
      },
    });
  }
  const world = makeWorld("reader-agent");
  return worldEnv(world, {
    place: "agent-pod",
    extra: { ACPX_STATE_HOME: owner.home, ACPX_POD_SA_DIR: owner.saDir, ACPX_POD_API_URL: apiUrl },
  });
}

test("control pod, stale heartbeat, the pod exists → alive, and the lease is untouched", async () => {
  const owner = makeWorld("judge-exists");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.pods.set(owner.pod.name, { uid: owner.pod.uid, phase: "Running" });
    await leaseFromPod(owner, "judge-exists-session", STALE);
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      const state = await readQueueOwnerState("judge-exists-session");
      assert.equal(state.state, "foreign_owner");
      assert.equal(state.alive, true);
      assert.equal(state.recoverable, false);
      assert.ok(fs.existsSync(queueLockFilePath("judge-exists-session")));
    });
  } finally {
    await api.close();
  }
});

test("control pod, stale heartbeat, the pod is gone (node Ready) → dead_owner by `pod-gone`", async () => {
  const owner = makeWorld("judge-gone");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.nodes.set(owner.pod.node, "True");
    await leaseFromPod(owner, "judge-gone-session", STALE);
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      const state = await readQueueOwnerState("judge-gone-session");
      assert.equal(state.state, "dead_owner");
      assert.equal(state.alive, false);
      assert.equal(state.deathReason, "pod-gone");
      assert.equal(state.podEnd?.pod.uid, owner.pod.uid);
      assert.equal(
        state.podEnd?.terminal,
        undefined,
        "an absent pod has no object to read a reason from",
      );
    });
  } finally {
    await api.close();
  }
});

test("control pod, a terminal pod → dead_owner, and the OOMKilled reason is read from the pod object", async () => {
  const owner = makeWorld("judge-oom");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.pods.set(owner.pod.name, {
      uid: owner.pod.uid,
      phase: "Failed",
      containerStatuses: [
        { name: "sidecar", state: { terminated: { reason: "Completed", exitCode: 0 } } },
        { name: "agent", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } },
      ],
    });
    await leaseFromPod(owner, "judge-oom-session", STALE);
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      const state = await readQueueOwnerState("judge-oom-session");
      assert.equal(state.deathReason, "pod-terminal");
      assert.deepEqual(state.podEnd?.terminal, { reason: "OOMKilled", exitCode: 137 });
    });
  } finally {
    await api.close();
  }
});

test("control pod, the API server answers nothing useful → NOT dead: unknown is alive, the lease stays", async () => {
  const owner = makeWorld("judge-unknown");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.failure = "500";
    await leaseFromPod(owner, "judge-unknown-session", STALE);
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      const state = await readQueueOwnerState("judge-unknown-session");
      assert.equal(state.state, "foreign_owner");
      assert.equal(state.alive, null);
      assert.ok(fs.existsSync(queueLockFilePath("judge-unknown-session")));
    });
  } finally {
    await api.close();
  }
});

test("control pod, the pod is gone but its node is NotReady → unknown, not dead (a partitioned node may still run it)", async () => {
  const owner = makeWorld("judge-notready");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.nodes.set(owner.pod.node, "False");
    await leaseFromPod(owner, "judge-notready-session", STALE);
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      const state = await readQueueOwnerState("judge-notready-session");
      assert.equal(state.alive, null);
      assert.notEqual(state.state, "dead_owner");
    });
  } finally {
    await api.close();
  }
});

test("a lease whose pod uid is not the uid of the pod now under that name is dead (a replaced pod)", async () => {
  const owner = makeWorld("judge-replaced");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.nodes.set(owner.pod.node, "True");
    api.state.pods.set(owner.pod.name, {
      uid: "00000000-0000-4000-8000-000000000000",
      phase: "Running",
    });
    await leaseFromPod(owner, "judge-replaced-session", STALE);
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      assert.equal((await readQueueOwnerState("judge-replaced-session")).state, "dead_owner");
    });
  } finally {
    await api.close();
  }
});

test("a fresh heartbeat is alive and asks the API server nothing", async () => {
  const owner = makeWorld("judge-fresh");
  const api = await startFakeApi("dev-kit");
  try {
    await leaseFromPod(owner, "judge-fresh-session");
    await withEnv(readerEnv(owner, "control", api.url), async () => {
      const state = await readQueueOwnerState("judge-fresh-session");
      assert.equal(state.alive, true);
      assert.deepEqual(api.state.requests, []);
    });
  } finally {
    await api.close();
  }
});

test("negative: an agent pod reading ANOTHER pod's stale lease never asks the API server and never calls it dead", async () => {
  const owner = makeWorld("judge-other");
  const api = await startFakeApi("dev-kit");
  try {
    api.state.nodes.set(owner.pod.node, "True"); // were it asked, the answer would be `gone`
    await leaseFromPod(owner, "judge-other-session", STALE);
    await withEnv(readerEnv(owner, "other-pod", api.url), async () => {
      const state = await readQueueOwnerState("judge-other-session");
      assert.equal(state.state, "foreign_owner");
      assert.equal(state.alive, null);
      assert.deepEqual(api.state.requests, [], "an agent pod never asks about a lease holder");
    });
  } finally {
    await api.close();
  }
});

test("a lease naming THIS pod is judged by pid, as today — never by the API server", async () => {
  const owner = makeWorld("judge-own");
  const api = await startFakeApi("dev-kit");
  try {
    await leaseFromPod(owner, "judge-own-session", STALE);
    const env = worldEnv(owner, { place: "agent-pod", podMode: true });
    await withEnv({ ...env, ACPX_POD_API_URL: api.url }, async () => {
      const state = await readQueueOwnerState("judge-own-session");
      assert.equal(state.scope, "local");
      assert.deepEqual(api.state.requests, []);
    });
  } finally {
    await api.close();
  }
});
