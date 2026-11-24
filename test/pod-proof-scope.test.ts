import assert from "node:assert/strict";
import test from "node:test";
import { tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { sessionKey } from "../src/pod/placement.js";
import { localProofScope } from "../src/pod/proof-scope.js";
import { agentPodNameFor, makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";
import {
  RECORD_ID,
  writeLeaseGarbage,
  writeLeaseWithBadPod,
  writePodLease,
} from "./pod-proof-helpers.js";

// Block A11 (brick e867b917), items 2 + 4 (C91: "transcript removal for a session runs only in that
// session's pod or when it has none"). `localProofScope` says whether THIS process's `/proc` is the whole
// world for a session; the transcript removers keep every copy when it is not. Pods are stood up through
// the product's own seams (`ACPX_POD_TEST_HOME`, `NV_POD_*`), state in the world's sandbox.

// ---- the scope function (A-67: the lease decides, in or out of pod mode) ----

test("A11 scope, a host with no pod identity that was never switched: local, the lease is never read", async () => {
  const world = makeWorld("ps-never");
  writeLeaseGarbage(world, RECORD_ID);
  await withEnv(worldEnv(world, { podMode: false, identity: false }), async () => {
    assert.deepEqual(await localProofScope(RECORD_ID), { local: true });
  });
  // No pod facts at all (a rig, a suite): same.
  assert.deepEqual(await localProofScope(RECORD_ID, { HOME: world.home }), { local: true });
});

test("A11 scope, pod mode OFF after a revert: a lease that names a living pod is NOT local (row 67.1)", async () => {
  const world = makeWorld("ps-revert");
  await writePodLease(world, RECORD_ID);
  for (const podMode of [false, true]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.deepEqual(
        await localProofScope(RECORD_ID),
        { local: false, reason: "session-in-pod" },
        `podMode=${podMode}`,
      );
      assert.deepEqual(await localProofScope("rec-another-session"), { local: true });
    });
  }
});

test("A11 scope: no lease, or a lease without a pod field, is local — in and out of pod mode", async () => {
  const world = makeWorld("ps-local");
  for (const podMode of [false, true]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.deepEqual(await localProofScope(RECORD_ID), { local: true }, "no lease");
    });
  }
  await withEnv(worldEnv(world, { podMode: false }), async () => {
    assert(await tryAcquireQueueOwnerLease(RECORD_ID)); // written on the control pod: no `pod`
  });
  for (const podMode of [false, true]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.deepEqual(await localProofScope(RECORD_ID), { local: true }, "a lease without pod");
    });
  }
});

test("A11 scope fails closed: an unreadable lease (switch on or off), or a switched host that cannot name its pod", async () => {
  const world = makeWorld("ps-closed");
  writeLeaseGarbage(world, RECORD_ID);
  for (const podMode of [false, true]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.deepEqual(await localProofScope(RECORD_ID), {
        local: false,
        reason: "pod-unreadable",
      });
    });
  }
  const noIdentity = makeWorld("ps-closed-id");
  await withEnv(worldEnv(noIdentity, { podMode: true, identity: false }), async () => {
    assert.deepEqual(await localProofScope("rec-x"), { local: false, reason: "pod-unreadable" });
  });
});

test("A11 scope, inside an agent pod: local only for that session's own pod", async () => {
  const id = "rec-own-pod-session";
  const world = makeWorld("ps-own", { podName: agentPodNameFor(sessionKey(id)) });
  await withEnv(worldEnv(world, { place: "agent-pod", podMode: true }), async () => {
    assert.deepEqual(await localProofScope(id), { local: true });
    assert.deepEqual(await localProofScope("rec-someone-else"), {
      local: false,
      reason: "other-pod",
    });
  });
});

test("A11 scope fails closed on a lease whose `pod` key is present but unreadable (TE LOW-1) — in and out of pod mode", async () => {
  const shapes: Array<[string, unknown]> = [
    ["no uid", { name: "ag-x", node: "n1" }],
    ["not an object", "ag-x"],
    ["null", null],
    ["empty object", {}],
  ];
  for (const [label, podValue] of shapes) {
    const world = makeWorld(`ps-badpod-${label.replace(/\W/g, "")}`);
    await writeLeaseWithBadPod(world, RECORD_ID, podValue);
    for (const podMode of [false, true]) {
      await withEnv(worldEnv(world, { podMode }), async () => {
        assert.deepEqual(
          await localProofScope(RECORD_ID),
          { local: false, reason: "pod-unreadable" },
          `${label} podMode=${podMode}`,
        );
      });
    }
  }
});

test("A11 scope: a lease with NO pod key at all is still local (the control for the malformed-pod rows)", async () => {
  const world = makeWorld("ps-nopodkey");
  await writeLeaseWithBadPod(world, RECORD_ID, undefined);
  for (const podMode of [false, true]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.deepEqual(await localProofScope(RECORD_ID), { local: true }, `podMode=${podMode}`);
    });
  }
});
