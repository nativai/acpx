import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDeployStalenessProbe,
  decideIdleOwnerRelease,
  type DecideIdleOwnerReleaseInput,
} from "../src/cli/session/queue-owner-runtime.js";
import { makeWorld, withEnv, worldEnv, type PodWorld } from "./pod-owner-helpers.js";

// Block A11 (brick e867b917), C9 "Staleness" + A-35: in an agent pod the deploy-staleness token is
// "`releases.acpx` is not the release `/data/runtime/acpx` points to". Every probe stands in a pod
// through the product's own seams (`ACPX_POD_TEST_HOME`, `NV_POD_*`, `ACPX_POD_TEST_PID1_ENVIRON`) and
// reads the release layout from `ACPX_TEST_RUNTIME_DIR` (honoured only under `NODE_TEST_CONTEXT`).

const BASE_NOW = 1_700_000_000_000;

function gateInput(
  deployDiffers: () => boolean | Promise<boolean>,
  overrides: Partial<DecideIdleOwnerReleaseInput> = {},
): DecideIdleOwnerReleaseInput {
  return {
    ttlMs: 10_000,
    hasActiveTurn: false,
    now: BASE_NOW,
    lastIdleDrainActivityAt: 0,
    lastTaskCompletedAt: BASE_NOW,
    quiescenceWindowMs: 10_000,
    idleReleaseMs: 0, // the memory path is off: only the staleness reason can release
    liveBackgroundTaskCount: 0,
    deployDiffers,
    recordClosed: () => false,
    ...overrides,
  };
}

type Runtime = { dir: string; infoFile: string };

/** A control-side runtime: `.releases/acpx/<each name>` and `acpx -> .releases/acpx/<current>`. */
function makeRuntime(world: PodWorld, releases: string[], current: string | null): Runtime {
  const dir = path.join(world.root, "runtime");
  for (const name of releases) {
    fs.mkdirSync(path.join(dir, ".releases", "acpx", name), { recursive: true });
  }
  if (current !== null) {
    fs.symlinkSync(path.join(".releases", "acpx", current), path.join(dir, "acpx"));
  }
  const infoFile = path.join(world.root, "info.json");
  fs.writeFileSync(infoFile, JSON.stringify({ acpx: { sha: "sha-1" } }));
  return { dir, infoFile };
}

function relink(runtime: Runtime, to: string): void {
  const link = path.join(runtime.dir, "acpx");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(".releases", "acpx", to), link);
}

function podEnv(world: PodWorld, runtime: Runtime, pinned: string | undefined, more = {}) {
  return worldEnv(world, {
    place: "agent-pod",
    podMode: true,
    extra: {
      ACPX_TEST_RUNTIME_DIR: runtime.dir,
      ACPX_DEPLOY_VERSION_FILE: runtime.infoFile,
      ...(pinned === undefined ? {} : { NV_RUNTIME_RELEASES: JSON.stringify({ acpx: pinned }) }),
      ...more,
    },
  });
}

test("A11 pod: pinned A, the box's link now names B → an idle owner is released as deploy-staleness", async () => {
  const world = makeWorld("rs-stale");
  const runtime = makeRuntime(world, ["A", "B"], "A");
  await withEnv(podEnv(world, runtime, "A"), async () => {
    const probe = createDeployStalenessProbe();
    assert.equal(await probe(), false, "current == pinned: not stale");
    assert.deepEqual(await decideIdleOwnerRelease(gateInput(probe)), { release: false });
    relink(runtime, "B");
    assert.equal(await probe(), true);
    assert.deepEqual(await decideIdleOwnerRelease(gateInput(probe)), {
      release: true,
      reason: "deploy-staleness",
    });
  });
});

test("A11 pod negative: a stale owner with an ACTIVE turn is never released", async () => {
  const world = makeWorld("rs-active");
  const runtime = makeRuntime(world, ["A", "B"], "B");
  await withEnv(podEnv(world, runtime, "A"), async () => {
    const probe = createDeployStalenessProbe();
    assert.equal(await probe(), true);
    assert.deepEqual(await decideIdleOwnerRelease(gateInput(probe, { hasActiveTurn: true })), {
      release: false,
    });
    assert.deepEqual(
      await decideIdleOwnerRelease(gateInput(probe, { liveBackgroundTaskCount: 1 })),
      { release: false },
    );
  });
});

test("A11 pod, A-35: NV_RUNTIME_RELEASES only in PID 1's environment still judges", async () => {
  const world = makeWorld("rs-pid1");
  const runtime = makeRuntime(world, ["A", "B"], "B");
  const standIn = path.join(world.root, "pid1.environ");
  fs.writeFileSync(standIn, `NV_RUNTIME_RELEASES=${JSON.stringify({ acpx: "A" })}\0`);
  await withEnv(
    podEnv(world, runtime, undefined, { ACPX_POD_TEST_PID1_ENVIRON: standIn }),
    async () => {
      assert.equal(await createDeployStalenessProbe()(), true);
    },
  );
});

test("A11 pod negative: no pinned acpx release (unset, empty, not JSON, no acpx key) → never stale", async () => {
  const world = makeWorld("rs-nopin");
  const runtime = makeRuntime(world, ["A", "B"], "B");
  for (const raw of [undefined, "", "   ", "not json", JSON.stringify({ pi: "x" })]) {
    const extra = raw === undefined ? {} : { NV_RUNTIME_RELEASES: raw };
    await withEnv(podEnv(world, runtime, undefined, extra), async () => {
      assert.equal(await createDeployStalenessProbe()(), false, String(raw));
    });
  }
});

test("A11 pod negative: link absent / a directory / a foreign link → never stale, never a throw", async () => {
  const world = makeWorld("rs-badlink");
  const runtime = makeRuntime(world, ["A"], null);
  await withEnv(podEnv(world, runtime, "A"), async () => {
    const probe = createDeployStalenessProbe();
    assert.equal(await probe(), false, "link absent");
    fs.mkdirSync(path.join(runtime.dir, "acpx"));
    assert.equal(await probe(), false, "a directory is not a link");
    fs.rmdirSync(path.join(runtime.dir, "acpx"));
    fs.symlinkSync("/usr/local/lib/node_modules/acpx", path.join(runtime.dir, "acpx"));
    assert.equal(await probe(), false, "a foreign link is not release-shaped");
  });
});

test("A11 pod: the token is by RELEASE, not by the box's info.json sha", async () => {
  const world = makeWorld("rs-sha");
  const runtime = makeRuntime(world, ["A"], "A");
  await withEnv(podEnv(world, runtime, "A"), async () => {
    const probe = createDeployStalenessProbe();
    // The box deployed something else: its record moves on, the pod's release did not change.
    fs.writeFileSync(runtime.infoFile, JSON.stringify({ acpx: { sha: "sha-2" } }));
    assert.equal(await probe(), false, "info.json differs, release equal → not stale");
  });
});

test("A11 pod: an owner started on a NEWER info.json than its pinned release is still caught", async () => {
  // The case the old token missed: info.json is already new at the owner's start.
  const world = makeWorld("rs-late");
  const runtime = makeRuntime(world, ["A", "B"], "B");
  fs.writeFileSync(runtime.infoFile, JSON.stringify({ acpx: { sha: "sha-new" } }));
  await withEnv(podEnv(world, runtime, "A"), async () => {
    assert.equal(await createDeployStalenessProbe()(), true);
  });
});

// ---- pod mode OFF: today's token, byte for byte ----

function controlEnv(world: PodWorld, runtime: Runtime, more: Record<string, string> = {}) {
  return worldEnv(world, {
    extra: {
      ACPX_TEST_RUNTIME_DIR: runtime.dir,
      ACPX_DEPLOY_VERSION_FILE: runtime.infoFile,
      NV_RUNTIME_RELEASES: JSON.stringify({ acpx: "A" }),
      ...more,
    },
  });
}

test("A11 pod OFF: on a control host the info.json sha still decides", async () => {
  const world = makeWorld("rs-off-sha");
  const runtime = makeRuntime(world, ["A", "B"], "A");
  await withEnv(controlEnv(world, runtime), async () => {
    const probe = createDeployStalenessProbe();
    assert.equal(await probe(), false);
    fs.writeFileSync(runtime.infoFile, JSON.stringify({ acpx: { sha: "sha-2" } }));
    assert.equal(await probe(), true, "a new sha is stale there, as before");
  });
});

test("A11 pod OFF negative: on a control host a differing release link is NOT consulted", async () => {
  const world = makeWorld("rs-off-link");
  const runtime = makeRuntime(world, ["A", "B"], "A");
  await withEnv(controlEnv(world, runtime), async () => {
    const probe = createDeployStalenessProbe();
    relink(runtime, "B"); // NV_RUNTIME_RELEASES says A, the link says B — no place file
    assert.equal(await probe(), false, "the release token is an agent-pod arm only");
  });
  // The same facts with the switch on but still no place file: a control pod, so still today's token.
  await withEnv(controlEnv(world, runtime, { ACPX_OWNER_PLACEMENT: "pod" }), async () => {
    assert.equal(await createDeployStalenessProbe()(), false);
  });
});

test("A11 pod OFF: no deploy record and no entry point at all stays 'never recycle'", async () => {
  const world = makeWorld("rs-off-none");
  const runtime = makeRuntime(world, ["A"], "A");
  fs.rmSync(runtime.infoFile);
  const saved = process.argv[1];
  process.argv[1] = path.join(os.tmpdir(), "no-such-entry-point.js");
  try {
    await withEnv(controlEnv(world, runtime), async () => {
      assert.equal(await createDeployStalenessProbe()(), false);
    });
  } finally {
    process.argv[1] = saved;
  }
});
