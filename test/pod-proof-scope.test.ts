import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { runTranscriptsDedup } from "../src/cli/transcripts-dedup.js";
import { transcriptCwdHash, transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import type { SubscriptionRegistry } from "../src/config/subscriptions.js";
import { reapLeftBehindTranscripts } from "../src/config/transcript-reap.js";
import { sessionKey } from "../src/pod/placement.js";
import { localProofScope } from "../src/pod/proof-scope.js";
import type { LiveProcessScan } from "../src/process-population.js";
import {
  sweepAbandonedSessionRecords,
  describeAbandonedRecordSweep,
} from "../src/session/abandoned-record-sweep.js";
import { evaluateLiveness } from "../src/session/archive/liveness.js";
import { isSessionActive } from "../src/session/export.js";
import type { SessionRecord } from "../src/types.js";
import {
  agentPodNameFor,
  makeWorld,
  withEnv,
  worldEnv,
  type PodWorld,
} from "./pod-owner-helpers.js";
import {
  ageFile,
  conversation,
  jsonl,
  sessionIdFor,
  sha256File,
  writeFileAt,
  writeRecordFixture,
  writeRegistry,
} from "./transcript-fixture-test-helpers.js";

// Block A11 (brick e867b917), items 2 + 4 (C91: "transcript removal for a session runs only in that
// session's pod or when it has none"). `localProofScope` says whether THIS process's `/proc` is the whole
// world for a session; the transcript removers keep every copy when it is not. Pods are stood up through
// the product's own seams (`ACPX_POD_TEST_HOME`, `NV_POD_*`), state in the world's sandbox.

const RECORD_ID = "rec-proof-scope-1";
const ELEVEN_MIN = 11 * 60_000;
const CWD = "/work/proof";

function writeLeaseGarbage(world: PodWorld, recordId: string): string {
  const file = queueLockFilePath(recordId, world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not a lease");
  return file;
}

/** A lease that names an agent pod, written the way an owner there writes it. */
async function writePodLease(world: PodWorld, recordId: string): Promise<void> {
  await withEnv(worldEnv(world, { place: "agent-pod", podMode: true }), async () => {
    assert(await tryAcquireQueueOwnerLease(recordId));
  });
  fs.rmSync(path.join(world.home, ".nv-agent"));
}

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

// ---- transcript removal (item 4) ----

type Fx = { registry: SubscriptionRegistry; active: string; leftBehind: string; home: string };

async function withTranscripts(world: PodWorld, run: (fx: Fx) => Promise<void>): Promise<void> {
  const home = world.home;
  const dir = (name: string) => path.join(home, ".acpx", "subscriptions", name);
  for (const name of ["subA", "subB"]) {
    fs.mkdirSync(dir(name), { recursive: true });
  }
  const registry: SubscriptionRegistry = {
    default: "subA",
    subscriptions: ["subA", "subB"].map((id) => ({
      id,
      label: id,
      configDir: dir(id),
      account: id,
    })),
  };
  const acpSessionId = sessionIdFor("proof-scope");
  const conv = conversation(acpSessionId, { pairs: 16 });
  const newer = conversation(acpSessionId, {
    pairs: 3,
    seed: "newer",
    startMinute: 200,
    parent: conv.lastUuid,
  });
  const active = transcriptJsonlPath(dir("subB"), CWD, acpSessionId);
  const leftBehind = transcriptJsonlPath(dir("subA"), CWD, acpSessionId);
  await writeFileAt(active, jsonl(conv.lines) + jsonl(newer.lines));
  await writeFileAt(leftBehind, jsonl(conv.lines));
  await ageFile(leftBehind, ELEVEN_MIN);
  await run({ registry, active, leftBehind, home });
}

function recordOf(recordId: string, acpSessionId: string): SessionRecord {
  return {
    acpxRecordId: recordId,
    cwd: CWD,
    acpSessionId,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    acpx: { session_options: { profile: "subB" } },
  } as unknown as SessionRecord;
}

async function reap(world: PodWorld, fx: Fx, recordId = RECORD_ID) {
  return await reapLeftBehindTranscripts({
    record: recordOf(recordId, sessionIdFor("proof-scope")),
    lookup: { homeDir: fx.home, registry: fx.registry },
  });
}

test("A11 removal NEGATIVE (row 67.1): the session's lease names a pod → the copy is kept, byte for byte — pod mode ON and pod mode OFF after a revert", async () => {
  for (const podMode of [true, false]) {
    const world = makeWorld(`rm-inpod-${podMode}`);
    await writePodLease(world, RECORD_ID);
    await withTranscripts(world, async (fx) => {
      const before = await sha256File(fx.leftBehind);
      await withEnv(worldEnv(world, { podMode }), async () => {
        const summary = await reap(world, fx);
        assert.equal(summary.files.length, 0, `podMode=${podMode}: nothing removed`);
        assert.equal(summary.keptReasons["not-local-proof"], 1);
      });
      assert.equal(await sha256File(fx.leftBehind), before);
    });
  }
});

test("A11 removal positive controls: no lease / a lease without pod / own pod / a never-switched host → removed", async () => {
  for (const podMode of [true, false]) {
    // no lease
    const a = makeWorld(`rm-nopod-${podMode}`);
    await withTranscripts(a, async (fx) => {
      await withEnv(worldEnv(a, { podMode }), async () => {
        assert.equal((await reap(a, fx)).files.length, 1);
      });
      assert.equal(fs.existsSync(fx.leftBehind), false);
    });
    // a lease written on the control pod (no `pod`)
    const l = makeWorld(`rm-lease-nopod-${podMode}`);
    await withEnv(worldEnv(l, { podMode: false }), async () => {
      assert(await tryAcquireQueueOwnerLease(RECORD_ID));
    });
    await withTranscripts(l, async (fx) => {
      await withEnv(worldEnv(l, { podMode }), async () => {
        assert.equal((await reap(l, fx)).files.length, 1);
      });
      assert.equal(fs.existsSync(fx.leftBehind), false);
    });
  }
  // inside the session's own pod
  const b = makeWorld("rm-own", { podName: agentPodNameFor(sessionKey(RECORD_ID)) });
  await withTranscripts(b, async (fx) => {
    await withEnv(worldEnv(b, { place: "agent-pod", podMode: true }), async () => {
      assert.equal((await reap(b, fx)).files.length, 1);
    });
    assert.equal(fs.existsSync(fx.leftBehind), false);
  });
  // a host that never had a pod identity: a pod-naming lease on disk is never looked at (row 67.3 b)
  const c = makeWorld("rm-never");
  await writePodLease(c, RECORD_ID);
  await withTranscripts(c, async (fx) => {
    await withEnv(worldEnv(c, { podMode: false, identity: false }), async () => {
      assert.equal((await reap(c, fx)).files.length, 1);
    });
    assert.equal(fs.existsSync(fx.leftBehind), false);
  });
});

test("A11 removal NEGATIVE: another pod's session, and an unreadable lease (switch on or off) → kept", async () => {
  const other = makeWorld("rm-other", { podName: agentPodNameFor(sessionKey("rec-not-mine")) });
  await withTranscripts(other, async (fx) => {
    await withEnv(worldEnv(other, { place: "agent-pod", podMode: true }), async () => {
      assert.equal((await reap(other, fx)).keptReasons["not-local-proof"], 1);
    });
    assert.equal(fs.existsSync(fx.leftBehind), true);
  });
  for (const podMode of [true, false]) {
    const bad = makeWorld(`rm-bad-${podMode}`);
    writeLeaseGarbage(bad, RECORD_ID);
    await withTranscripts(bad, async (fx) => {
      await withEnv(worldEnv(bad, { podMode }), async () => {
        assert.equal((await reap(bad, fx)).keptReasons["not-local-proof"], 1);
      });
      assert.equal(fs.existsSync(fx.leftBehind), true);
    });
  }
});

// ---- `acpx transcripts dedup` ----

test("A11 dedup: a session whose lease names a pod is skipped as not-local-proof; the same tree with no pod lease is planned", async () => {
  const world = makeWorld("dd");
  const home = world.home;
  await writeRegistry(home, ["subA", "subB"], "subA");
  const id = sessionIdFor("dd");
  const conv = conversation(id, { pairs: 16 });
  const newer = conversation(id, {
    pairs: 3,
    seed: "newer",
    startMinute: 200,
    parent: conv.lastUuid,
  });
  const slug = transcriptCwdHash(CWD);
  const copy = (sub: string, name: string) =>
    path.join(home, ".acpx", "subscriptions", sub, "projects", slug, name);
  await writeFileAt(copy("subB", `${id}.jsonl`), jsonl(conv.lines) + jsonl(newer.lines));
  const sidecar = copy("subB", `${id}.superseded-2026-10-01T00-00-00.000Z.jsonl`);
  await writeFileAt(sidecar, jsonl(conv.lines));
  await ageFile(sidecar, 2 * 60 * 60_000);
  await ageFile(copy("subB", `${id}.jsonl`), 2 * 60 * 60_000);
  await writeRecordFixture(home, {
    recordId: RECORD_ID,
    acpSessionId: id,
    cwd: CWD,
    profile: "subB",
  });
  await writePodLease(world, RECORD_ID);
  const noOwner = { ownerPossiblyAlive: async () => false };

  for (const podMode of [true, false]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      const report = await runTranscriptsDedup({
        apply: false,
        stateHome: home,
        userHome: home,
        deps: noOwner,
      });
      assert.deepEqual(
        report.skippedIds,
        [{ sessionId: id, reason: "not-local-proof" }],
        `podMode=${podMode}`,
      );
      assert.equal(report.actions.length, 0);
      assert.equal(fs.existsSync(sidecar), true, "the copy is untouched");
    });
  }
  fs.rmSync(queueLockFilePath(RECORD_ID, world.home));
  await withEnv(worldEnv(world, { podMode: true }), async () => {
    const report = await runTranscriptsDedup({
      apply: false,
      stateHome: home,
      userHome: home,
      deps: noOwner,
    });
    assert.equal(
      report.actions.length,
      1,
      "positive control: no pod lease, the sidecar is planned",
    );
  });
});

// ---- the other sites that judge a session by this host's process table (item 2) ----

const SCAN: LiveProcessScan = {
  scanned: 50,
  environRead: 50,
  pids: new Set<number>(),
  referencedDirs: new Set<string>(),
  referencedSessionIds: new Set<string>(),
};

async function sweepOne(recordId: string) {
  const closed: string[] = [];
  const result = await sweepAbandonedSessionRecords({
    records: [
      {
        acpxRecordId: recordId,
        closed: false,
        lastUsedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      } as unknown as SessionRecord,
    ],
    liveScan: SCAN,
    closeSession: async (id) => {
      closed.push(id);
    },
  });
  return { result, closed };
}

test("A11 sweep NEGATIVE (row 67.1 shape): an 'ownerless' record whose lease names a pod is not closed and is listed; pod mode off after a revert too", async () => {
  for (const podMode of [true, false]) {
    const world = makeWorld(`sw-${podMode}`);
    await writePodLease(world, RECORD_ID);
    await withEnv(worldEnv(world, { podMode }), async () => {
      const { result, closed } = await sweepOne(RECORD_ID);
      assert.deepEqual(
        closed,
        [],
        `podMode=${podMode}: closed a pod session on this host's census`,
      );
      assert.equal(result.retainedBy.notLocalProof, 1);
      assert.deepEqual(result.notLocalProofIds, [RECORD_ID]);
      assert.match(describeAbandonedRecordSweep(result), /notLocalProof=1\)/);
    });
  }
});

test("A11 sweep positive controls: no lease → closed as today, and the report line is byte-identical (no notLocalProof field)", async () => {
  const world = makeWorld("sw-ctl");
  await withEnv(worldEnv(world, { podMode: true }), async () => {
    const { result, closed } = await sweepOne(RECORD_ID);
    assert.deepEqual(closed, [RECORD_ID]);
    assert.equal(result.retainedBy.notLocalProof, 0);
    assert.doesNotMatch(describeAbandonedRecordSweep(result), /notLocalProof/);
  });
});

test("A11 archive liveness: a session whose lease names a pod is live (not-local-proof) before any pid compare; without one the pid verdict stands", async () => {
  const world = makeWorld("al");
  await writePodLease(world, RECORD_ID);
  const options = { wakeups: { status: "absent" } as const };
  for (const podMode of [true, false]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.deepEqual(await evaluateLiveness(RECORD_ID, RECORD_ID, [], undefined, options), {
        live: true,
        signal: "not-local-proof",
      });
    });
  }
  await withEnv(worldEnv(world, { podMode: true }), async () => {
    assert.deepEqual(
      await evaluateLiveness("rec-no-lease", "rec-no-lease", [], undefined, options),
      {
        live: false,
      },
    );
  });
});

test("A11 export: a session whose lease names a pod counts as active; without one a pid-less record does not", async () => {
  const world = makeWorld("ex");
  await writePodLease(world, RECORD_ID);
  const record = (id: string) => ({ acpxRecordId: id, closed: false }) as unknown as SessionRecord;
  for (const podMode of [true, false]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.equal(await isSessionActive(record(RECORD_ID)), true, `podMode=${podMode}`);
      assert.equal(await isSessionActive(record("rec-no-lease")), false);
    });
  }
});
