import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { readQueueOwnerStatus, tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { recordPodEnd } from "../src/pod/pod-end.js";
import { parseSessionRecord } from "../src/session/persistence.js";
import { startFakeApi } from "./pod-lock-fake-api.js";
import { makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Block A4 (brick 30df3a5b), C3.3: when the control pod's death proof says `gone`, the session record
// keeps why — an agent-pod OOM is invisible to the control pod's governor. Sandbox state homes only.

const SESSION = "pod-end-session";

async function writeRecord(home: string): Promise<void> {
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: SESSION,
      acpSessionId: "acp-pod-end",
      agentCommand: "claude",
      cwd: home,
    }),
  );
}

function readAcpx(home: string): Record<string, unknown> | undefined {
  const raw = JSON.parse(fs.readFileSync(sessionFilePath(home, SESSION), "utf8")) as {
    acpx?: Record<string, unknown>;
  };
  return raw.acpx;
}

const POD = { name: "ag-abc", uid: "uid-1", node: "n1", namespace: "dev-kit" };

test("recordPodEnd writes acpx.last_pod_end once per pod uid and survives the record's own parser", async () => {
  const world = makeWorld("podend-write");
  await writeRecord(world.home);
  await withEnv(worldEnv(world, { place: "control" }), async () => {
    const end = {
      pod: POD,
      proof: "pod-terminal" as const,
      terminal: { reason: "OOMKilled", exitCode: 137 },
    };
    assert.equal(await recordPodEnd(SESSION, end, () => new Date("2026-11-22T10:00:00Z")), true);
    assert.deepEqual(readAcpx(world.home)?.last_pod_end, {
      at: "2026-11-22T10:00:00.000Z",
      pod: "ag-abc",
      uid: "uid-1",
      proof: "pod-terminal",
      reason: "OOMKilled",
      exit_code: 137,
    });
    // Idempotent per uid: the same death proved again writes nothing (negative of the line above).
    assert.equal(await recordPodEnd(SESSION, end), false);
    // A LATER pod's end replaces it.
    const later = { pod: { ...POD, uid: "uid-2" }, proof: "pod-gone" as const };
    assert.equal(await recordPodEnd(SESSION, later), true);
    const stored = readAcpx(world.home)?.last_pod_end as Record<string, unknown>;
    assert.equal(stored.uid, "uid-2");
    assert.equal("reason" in stored, false, "a pod already absent has no reason to read");
    // The record still parses and the field is carried by the parser's allowlist.
    const parsed = parseSessionRecord(
      JSON.parse(fs.readFileSync(sessionFilePath(world.home, SESSION), "utf8")),
    );
    assert.equal(parsed?.acpx?.last_pod_end?.uid, "uid-2");
  });
});

test("recordPodEnd never throws and invents no record: a missing session is no write", async () => {
  const world = makeWorld("podend-missing");
  await withEnv(worldEnv(world, { place: "control" }), async () => {
    assert.equal(await recordPodEnd("no-such-session", { pod: POD, proof: "pod-gone" }), false);
    assert.equal(fs.existsSync(sessionFilePath(world.home, "no-such-session")), false);
  });
});

test("end to end: the control pod proves an OOMKilled pod gone, reaps its lease, and the record names OOMKilled", async () => {
  const owner = makeWorld("podend-e2e");
  const api = await startFakeApi("dev-kit");
  try {
    await writeRecord(owner.home);
    api.state.pods.set(owner.pod.name, {
      uid: owner.pod.uid,
      phase: "Failed",
      containerStatuses: [
        { name: "agent", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } },
      ],
    });
    await withEnv(worldEnv(owner, { place: "agent-pod", podMode: true }), async () => {
      assert(await tryAcquireQueueOwnerLease(SESSION));
      const file = queueLockFilePath(SESSION);
      const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(
        file,
        `${JSON.stringify({ ...lease, heartbeatAt: "2026-01-01T00:00:00.000Z" })}\n`,
      );
    });
    const control = makeWorld("podend-control");
    const env = worldEnv(control, {
      place: "control",
      identity: false,
      extra: {
        ACPX_STATE_HOME: owner.home,
        ACPX_POD_SA_DIR: owner.saDir,
        ACPX_POD_API_URL: api.url,
      },
    });
    await withEnv(env, async () => {
      // A read verb that finds a provably gone owner reaps its lease — and keeps why.
      assert.equal(await readQueueOwnerStatus(SESSION), undefined);
      assert.equal(fs.existsSync(queueLockFilePath(SESSION)), false);
    });
    const end = readAcpx(owner.home)?.last_pod_end as Record<string, unknown>;
    assert.equal(end.reason, "OOMKilled");
    assert.equal(end.exit_code, 137);
    assert.equal(end.proof, "pod-terminal");
    assert.equal(end.uid, owner.pod.uid);
  } finally {
    await api.close();
  }
});

test("negative: an unknown proof reaps nothing and records nothing", async () => {
  const owner = makeWorld("podend-unknown");
  const api = await startFakeApi("dev-kit");
  try {
    await writeRecord(owner.home);
    api.state.failure = "500";
    await withEnv(worldEnv(owner, { place: "agent-pod", podMode: true }), async () => {
      assert(await tryAcquireQueueOwnerLease(SESSION));
      const file = queueLockFilePath(SESSION);
      const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(
        file,
        `${JSON.stringify({ ...lease, heartbeatAt: "2026-01-01T00:00:00.000Z" })}\n`,
      );
    });
    const control = makeWorld("podend-control2");
    const env = worldEnv(control, {
      place: "control",
      identity: false,
      extra: {
        ACPX_STATE_HOME: owner.home,
        ACPX_POD_SA_DIR: owner.saDir,
        ACPX_POD_API_URL: api.url,
      },
    });
    await withEnv(env, async () => {
      assert.ok(await readQueueOwnerStatus(SESSION));
      assert.equal(fs.existsSync(queueLockFilePath(SESSION)), true);
    });
    assert.equal(readAcpx(owner.home)?.last_pod_end, undefined);
  } finally {
    await api.close();
  }
});
