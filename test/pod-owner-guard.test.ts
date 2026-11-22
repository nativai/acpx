import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { refuseWakeWhilePodNotGone } from "../src/cli/session/pod-wake-guard.js";
import { buildQueueOwnerSpawnOptions } from "../src/cli/session/queue-owner-process.js";
import {
  spawnAndAwaitQueueOwner,
  type SendSessionRuntimeDeps,
} from "../src/cli/session/queue-owner-runtime.js";
import { CALLER_IDENTITY_VARS } from "../src/pod/caller-identity.js";
import {
  assertOwnerEntryInOwnPod,
  OwnerOutsidePodError,
  ownerInheritedEnv,
} from "../src/pod/owner-pod.js";
import { agentPodName } from "../src/pod/placement.js";
import { textPrompt } from "../src/prompt-content.js";
import type { OutputFormatter } from "../src/types.js";
import { failWith, putNode, putPod, requestLines, startKitApi } from "./pod-kit-api-helpers.js";
import { makeWorld, withEnv, worldEnv, writePlaceFile } from "./pod-owner-helpers.js";

// Block A4 (brick 30df3a5b): the owner-entry guard (C7.2 `owner_outside_pod`), the owner spawn's
// environment (C2 "What the owner inherits"), and the A-16 rollback guard. Sandbox state homes only.

const SESSION = "guard-session-1";
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// ---------------------------------------------------------------------------------------------
// The owner-entry guard
// ---------------------------------------------------------------------------------------------

test("pod mode on the control pod: the owner entry refuses with `owner_outside_pod session=<id>` (exit 2)", async () => {
  const world = makeWorld("guard-control");
  await withEnv(worldEnv(world, { place: "control", podMode: true }), () => {
    assert.throws(
      () => assertOwnerEntryInOwnPod(SESSION),
      (error: unknown) => {
        assert(error instanceof OwnerOutsidePodError);
        assert.equal(error.stderrLine, `acpx: REFUSED reason=owner_outside_pod session=${SESSION}`);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  });
});

test("the session's own pod may own it; another session's pod, a utility pod and a pod that cannot say which may not", async () => {
  const own = makeWorld("guard-own", { podName: agentPodName(SESSION) });
  await withEnv(worldEnv(own, { place: "agent-pod", podMode: true }), () => {
    assert.doesNotThrow(() => assertOwnerEntryInOwnPod(SESSION));
    // The same pod, asked to own ANOTHER session: refused (negative of the line above).
    assert.throws(() => assertOwnerEntryInOwnPod("some-other-session"), OwnerOutsidePodError);
  });
  const util = makeWorld("guard-util", { podName: "ag-util-pool" });
  await withEnv(worldEnv(util, { place: "agent-pod", podMode: true }), () => {
    assert.throws(() => assertOwnerEntryInOwnPod(SESSION), OwnerOutsidePodError);
  });
  const empty = makeWorld("guard-empty", { podName: agentPodName(SESSION) });
  writePlaceFile(empty, "");
  await withEnv(worldEnv(empty, { podMode: true }), () => {
    assert.throws(() => assertOwnerEntryInOwnPod(SESSION), OwnerOutsidePodError);
  });
});

test("A-28 witness: the kernel hostname `ag-…` with no place file is not the session's pod — refused", async () => {
  const world = makeWorld("guard-hostname");
  const env = worldEnv(world, {
    podMode: true,
    extra: { ACPX_POD_TEST_HOSTNAME: agentPodName(SESSION) },
  });
  await withEnv(env, () => {
    assert.throws(() => assertOwnerEntryInOwnPod(SESSION), OwnerOutsidePodError);
  });
});

test("an agent pod with a state home of its own (switch off) still owns only its own session", async () => {
  const world = makeWorld("guard-rig", { podName: agentPodName(SESSION) });
  const rig = path.join(world.root, "rig-state");
  fs.mkdirSync(rig);
  const env = worldEnv(world, { place: "agent-pod", extra: { ACPX_STATE_HOME: rig } });
  await withEnv(env, () => {
    assert.doesNotThrow(() => assertOwnerEntryInOwnPod(SESSION));
    assert.throws(() => assertOwnerEntryInOwnPod("someone-else"), OwnerOutsidePodError);
  });
});

test("negative: outside pod mode on the control pod the owner entry is today's — nothing refused", async () => {
  const world = makeWorld("guard-off");
  await withEnv(worldEnv(world, { place: "control", podMode: false }), () => {
    assert.doesNotThrow(() => assertOwnerEntryInOwnPod(SESSION));
  });
});

test("the real `__queue-owner` entry exits 2 on the control pod in pod mode and creates no lease", async () => {
  const world = makeWorld("guard-real");
  const patch = worldEnv(world, { place: "control", podMode: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  env.ACPX_QUEUE_OWNER_PAYLOAD = JSON.stringify({
    sessionId: SESSION,
    permissionMode: "approve-reads",
  });
  const child = spawn(process.execPath, [CLI_PATH, "__queue-owner"], { env, stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 2, stderr);
  assert.equal(
    stderr.split("\n")[0],
    `acpx: REFUSED reason=owner_outside_pod session=${SESSION}`,
    "the machine token is the first stderr line",
  );
  await withEnv({ ACPX_STATE_HOME: world.home }, () => {
    assert.equal(fs.existsSync(queueLockFilePath(SESSION)), false, "no lease was taken");
  });
});

// ---------------------------------------------------------------------------------------------
// What the owner inherits (C2)
// ---------------------------------------------------------------------------------------------

const ROUTED = {
  ACPX_ROUTED: "1",
  ACPX_ROUTED_CONTRACT: "1",
  ACPX_ROUTED_CALL_ID: "call-1",
  ACPX_ROUTED_DEADLINE_MS: "1",
  ACPX_ROUTED_PAYLOAD: "/x",
};
const IDENTITY: Record<string, string> = Object.fromEntries(
  CALLER_IDENTITY_VARS.map((name) => [name, `value-of-${name}`]),
);

function podModeEnv(world: ReturnType<typeof makeWorld>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const patch = worldEnv(world, {
    place: "agent-pod",
    podMode: true,
    extra: { ...ROUTED, ...IDENTITY, ACPX_ADMISSION_CLASS: "interactive", KEEP_ME: "yes" },
  });
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

test("in pod mode the owner spawn removes every ACPX_ROUTED_* variable and the caller identity", () => {
  const world = makeWorld("env-pod", { podName: agentPodName(SESSION) });
  const env = podModeEnv(world);
  const spawned = buildQueueOwnerSpawnOptions("{}", null, env).env;
  for (const name of [...Object.keys(ROUTED), ...CALLER_IDENTITY_VARS]) {
    assert.equal(name in spawned, false, `${name} is stripped`);
  }
  // Nothing else is touched: the owner is not given a smaller world than the control pod's owner gets.
  assert.equal(spawned.KEEP_ME, "yes");
  assert.equal(spawned.ACPX_ADMISSION_CLASS, "interactive");
  assert.equal(spawned.ACPX_QUEUE_OWNER_PAYLOAD, "{}");
});

test("a name that merely resembles the routed family is kept (negative: only ACPX_ROUTED and ACPX_ROUTED_*)", () => {
  const world = makeWorld("env-resemble", { podName: agentPodName(SESSION) });
  const env = { ...podModeEnv(world), ACPX_ROUTEDX: "keep", MY_ACPX_ROUTED_THING: "keep" };
  const kept = ownerInheritedEnv(env);
  assert.equal(kept.ACPX_ROUTEDX, "keep");
  assert.equal(kept.MY_ACPX_ROUTED_THING, "keep");
});

test("negative: outside pod mode the owner spawn keeps today's environment, routed variables included", async () => {
  const world = makeWorld("env-off");
  const env = podModeEnv(world);
  delete env.ACPX_OWNER_PLACEMENT;
  fs.rmSync(path.join(world.home, ".nv-agent"));
  const spawned = buildQueueOwnerSpawnOptions("{}", null, env).env;
  for (const name of [...Object.keys(ROUTED), ...CALLER_IDENTITY_VARS]) {
    assert.equal(spawned[name], env[name], `${name} is untouched outside pod mode`);
  }
});

// ---------------------------------------------------------------------------------------------
// A-16: a LOCAL wake while the lease names a pod that is not proven gone
// ---------------------------------------------------------------------------------------------

const NOOP_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  onPermissionEscalation() {},
  flush() {},
};

type Counting = { deps: SendSessionRuntimeDeps; spawns: () => number };

function countingDeps(guard?: SendSessionRuntimeDeps["refuseWakeWhilePodNotGone"]): Counting {
  let spawns = 0;
  const deps: SendSessionRuntimeDeps = {
    spawnQueueOwnerProcess: () => {
      spawns += 1;
      return { exit: undefined, dispose() {} };
    },
    submitToRunningOwner: async () =>
      spawns > 0 ? { queued: true, sessionId: SESSION, requestId: "r" } : undefined,
    waitMs: async () => {},
    readStartupFailureDetail: () => undefined,
    startupBudgetMs: 50,
    nowMs: (() => {
      let clock = 0;
      return () => (clock += 10);
    })(),
    maxSpawnAttempts: 1,
    ...(guard ? { refuseWakeWhilePodNotGone: guard } : {}),
  };
  return { deps, spawns: () => spawns };
}

const OPTIONS = {
  sessionId: SESSION,
  prompt: textPrompt("hi"),
  permissionMode: "approve-reads" as const,
  outputFormatter: NOOP_FORMATTER,
};

/** A lease written by `owner`'s agent pod, stale, in `owner`'s state home (no pod ever asked about it). */
async function staleLeaseFromPod(owner: ReturnType<typeof makeWorld>): Promise<void> {
  await withEnv(worldEnv(owner, { place: "agent-pod", podMode: true }), async () => {
    assert(await tryAcquireQueueOwnerLease(SESSION));
    const file = queueLockFilePath(SESSION);
    const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...lease, heartbeatAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
  });
}

function localControlEnv(owner: ReturnType<typeof makeWorld>, apiUrl: string) {
  const control = makeWorld("wake-control");
  return worldEnv(control, {
    place: "control",
    identity: false,
    extra: { ACPX_STATE_HOME: owner.home, ACPX_POD_SA_DIR: owner.saDir, ACPX_POD_API_URL: apiUrl },
  });
}

test("A-16: switch off, the lease names a pod that still exists → pod_starting turnover (75), NO local owner starts", async () => {
  const owner = makeWorld("wake-exists");
  const api = await startKitApi("dev-kit");
  try {
    // The pod's delete FAILED (or has not happened): the API server still shows it, so it is not gone.
    putPod(api, owner.pod.name, { uid: owner.pod.uid, phase: "Running" });
    putNode(api, owner.pod.node, "True");
    await staleLeaseFromPod(owner);
    const counting = countingDeps();
    await withEnv(localControlEnv(owner, api.url), async () => {
      await assert.rejects(
        async () => await spawnAndAwaitQueueOwner(OPTIONS, counting.deps),
        (error: unknown) => {
          const line = (error as { stderrLine?: string }).stderrLine;
          assert.equal(
            line,
            `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=${SESSION}`,
          );
          return true;
        },
      );
    });
    assert.equal(counting.spawns(), 0, "no local owner was started");
    // Nothing on the control pod wrote or removed a file the pod owns: the lease is as the pod left it.
    const lease = JSON.parse(
      fs.readFileSync(
        path.join(owner.home, ".acpx", "queues", path.basename(queueLockFilePath(SESSION))),
        "utf8",
      ),
    ) as { pod?: { uid: string } };
    assert.equal(lease.pod?.uid, owner.pod.uid);
  } finally {
    await api.close();
  }
});

test("A-16: the API server cannot be asked (unknown) → the same refusal; unknown is alive", async () => {
  const owner = makeWorld("wake-unknown");
  const api = await startKitApi("dev-kit");
  try {
    failWith(api, "500");
    await staleLeaseFromPod(owner);
    const counting = countingDeps();
    await withEnv(localControlEnv(owner, api.url), async () => {
      await assert.rejects(async () => await spawnAndAwaitQueueOwner(OPTIONS, counting.deps), {
        stderrLine: /reason=pod_starting .*phase=turnover/,
      });
    });
    assert.equal(counting.spawns(), 0);
  } finally {
    await api.close();
  }
});

test("A-16: the pod is proven gone → the wake proceeds and the stale lease is reaped by its proof", async () => {
  const owner = makeWorld("wake-gone");
  const api = await startKitApi("dev-kit");
  try {
    putNode(api, owner.pod.node, "True"); // no pod of that name, its node is Ready: gone
    await staleLeaseFromPod(owner);
    const counting = countingDeps();
    await withEnv(localControlEnv(owner, api.url), async () => {
      assert.ok(await spawnAndAwaitQueueOwner(OPTIONS, counting.deps));
      // The local owner that now starts acquires under the lease guard: the first call judges the stale
      // pod lease dead by the proof and reaps it, the retry (the owner's existing handshake) takes it.
      assert.equal(await tryAcquireQueueOwnerLease(SESSION), undefined, "first call reaps");
      const lease = await tryAcquireQueueOwnerLease(SESSION);
      assert(lease, "second call acquires");
      const onDisk = JSON.parse(fs.readFileSync(queueLockFilePath(SESSION), "utf8")) as object;
      assert.equal("pod" in onDisk, false, "the new local lease names no pod");
    });
    assert.equal(counting.spawns(), 1);
  } finally {
    await api.close();
  }
});

test("A-16 negative: a lease WITHOUT a pod field is today's — the guard asks nothing and starts a local owner", async () => {
  const world = makeWorld("wake-nopod");
  const api = await startKitApi("dev-kit");
  try {
    // A control-pod lease: no `pod`, written by a process that is not in an agent pod.
    await withEnv(worldEnv(world, { place: "control" }), async () => {
      assert(await tryAcquireQueueOwnerLease(SESSION));
    });
    const counting = countingDeps();
    await withEnv(
      worldEnv(world, { place: "control", extra: { ACPX_POD_API_URL: api.url } }),
      async () => {
        await spawnAndAwaitQueueOwner(OPTIONS, counting.deps);
      },
    );
    assert.equal(counting.spawns(), 1);
    assert.deepEqual(requestLines(api), [], "no death proof for a lease that names no pod");
  } finally {
    await api.close();
  }
});

test("A-16 unit rows: the guard applies only on a control-role host in local mode, and only a gone proof lets a wake through", async () => {
  const pod = { name: "ag-x", uid: "u1", node: "n1", namespace: "dev-kit" };
  const asked: string[] = [];
  const deps = (answer: "gone" | "exists" | "unknown", applies = true, withPod = true) => ({
    applies: () => applies,
    leasePod: async () => {
      asked.push("lease");
      return withPod ? pod : undefined;
    },
    prove: async () => {
      asked.push("prove");
      return answer === "gone" ? { answer, proof: "pod-gone" as const } : { answer };
    },
  });
  await refuseWakeWhilePodNotGone(SESSION, deps("gone"));
  await assert.rejects(refuseWakeWhilePodNotGone(SESSION, deps("exists")), {
    stderrLine: /phase=turnover/,
  });
  await assert.rejects(refuseWakeWhilePodNotGone(SESSION, deps("unknown")), {
    stderrLine: /phase=turnover/,
  });
  asked.length = 0;
  await refuseWakeWhilePodNotGone(SESSION, deps("exists", false));
  assert.deepEqual(asked, [], "pod mode / an agent pod: not this guard's case, nothing read");
  await refuseWakeWhilePodNotGone(SESSION, deps("exists", true, false));
  assert.deepEqual(asked, ["lease"], "no pod field: nothing proved");
});
