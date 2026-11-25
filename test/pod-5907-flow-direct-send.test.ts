import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src/acp/client.js";
import { tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { sendSessionDirect } from "../src/cli/session/runtime.js";
import { createQuietCaptureOutput } from "../src/flows/runtime-support.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { makeWorld, withEnv, worldEnv, type PodWorld, type WorldEnv } from "./pod-owner-helpers.js";
import { writePodLease } from "./pod-proof-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Brick 59070d68, row C1.2-F.1 (CONTRACTS-r4 C1.2 "A flow's direct send"): `sendSessionDirect` refuses BEFORE it
// writes anything — no record write, no stream writer, no marker, no lock — (i) on a control-role host in pod mode,
// (ii) in an agent pod whose target session's lease is held elsewhere. The refusals are the existing ones.
// The function is called DIRECTLY, as an in-process caller of `acpx/flows` would (no CLI placement step).

/** A mock adapter client: counts the prompts it is asked to run, never spawns anything. */
function mockClient(): { client: AcpClient; prompts: () => number } {
  let prompts = 0;
  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    markAdvertisement: () => 0,
    advertisedConfigOptionsSince: () => undefined,
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: async (): Promise<PromptResponse> => {
      prompts += 1;
      return { stopReason: "end_turn" };
    },
  };
  return { client: mock as unknown as AcpClient, prompts: () => prompts };
}

/** Every file of the session's directory and the queue directory, name → content hash. */
function snapshot(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [path.join(home, ".acpx", "sessions"), path.join(home, ".acpx", "queues")]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir).toSorted()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) {
        out[path.relative(home, full)] = createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
      }
    }
  }
  return out;
}

const SESSION = "rec-5907-direct";

function seedSession(world: PodWorld): void {
  const dir = path.join(world.home, ".acpx", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${SESSION}.stream.ndjson`),
    '{"jsonrpc":"2.0","method":"seed"}\n',
  );
  fs.writeFileSync(path.join(dir, `${SESSION}.owner.log`), "owner line\n");
}

async function directSend(
  client: AcpClient,
): Promise<Awaited<ReturnType<typeof sendSessionDirect>>> {
  return await sendSessionDirect({
    sessionId: SESSION,
    prompt: [{ type: "text", text: "hello" }],
    permissionMode: "approve-all",
    outputFormatter: createQuietCaptureOutput().formatter,
    client,
    timeoutMs: 20_000,
  });
}

async function inWorld(
  label: string,
  options: WorldEnv,
  run: (world: PodWorld) => Promise<void>,
  podName?: string,
): Promise<void> {
  const world = makeWorld(label, podName ? { podName } : {});
  try {
    await withEnv(
      worldEnv(world, { ...options, extra: { HOME: world.home, ...options.extra } }),
      async () => {
        await writeSessionRecord(
          makeSessionRecord({
            acpxRecordId: SESSION,
            acpSessionId: "acp-5907",
            agentCommand: "node mock-agent.js",
            cwd: world.home,
          }),
        );
        seedSession(world);
        await run(world);
      },
    );
  } finally {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
}

async function refused(world: PodWorld, pattern: RegExp, why: string): Promise<void> {
  const { client, prompts } = mockClient();
  const before = snapshot(world.home);
  await assert.rejects(
    async () => await directSend(client),
    (error: Error) => {
      assert.match(error.message, pattern, why);
      return true;
    },
  );
  assert.deepEqual(
    snapshot(world.home),
    before,
    `${why}: no file of the session or its queue changed`,
  );
  assert.equal(
    fs.existsSync(path.join(world.home, ".acpx", "sessions", `${SESSION}.markers.ndjson`)),
    false,
    `${why}: no sidecar either`,
  );
  assert.equal(prompts(), 0, `${why}: no turn was driven`);
}

test("C1.2-F.1 (i): a control-role host in pod mode refuses the direct send before anything is written — with a live pod's lease and with none", async () => {
  for (const withLease of [false, true]) {
    await inWorld(`f1i${withLease ? "l" : "n"}`, { podMode: true }, async (world) => {
      if (withLease) {
        const other = { ...makeWorld("f1io"), home: world.home };
        await writePodLease(other, SESSION);
      }
      await refused(
        world,
        /reason=bridge_on_control_pod nothing_started=true/,
        `control pod, pod mode, ${withLease ? "a lease naming a pod" : "no lease"}`,
      );
    });
  }
});

test("C1.2-F.1 (ii): in the utility pod, a session whose lease is held elsewhere is refused before anything is written — a POOL session (another pod's lease) and a HOME session (a lease without `pod`)", async () => {
  await inWorld("f1iip", { place: "agent-pod", podMode: true }, async (world) => {
    const other = { ...makeWorld("f1iipo"), home: world.home };
    await writePodLease(other, SESSION);
    await refused(
      world,
      /reason=pod_foreign_write file=session/,
      "pool session, lease names another pod",
    );
  });
  await inWorld("f1iih", { place: "agent-pod", podMode: true }, async (world) => {
    // A home owner's lease, written on the control pod: no pod identity, so no `pod` key.
    await withEnv(worldEnv(world, { podMode: false, identity: false }), async () => {
      assert.ok(await tryAcquireQueueOwnerLease(SESSION));
    });
    fs.writeFileSync(path.join(world.home, ".nv-agent"), `${world.pod.name}\n`);
    await refused(
      world,
      /reason=pod_foreign_write file=session/,
      "home session, lease without pod",
    );
  });
});

test("C1.2-F.1 (ii) fail-closed: an unreadable lease, and a lease whose pod key names no pod, are held elsewhere too", async () => {
  await inWorld("f1iiu", { place: "agent-pod", podMode: true }, async (world) => {
    const queues = path.join(world.home, ".acpx", "queues");
    fs.mkdirSync(queues, { recursive: true });
    const { queueLockFilePath } = await import("../src/cli/queue/paths.js");
    fs.writeFileSync(queueLockFilePath(SESSION, world.home), "{ not a lease");
    await refused(world, /reason=pod_foreign_write file=session/, "an unreadable lease");
  });
});

test("C1.2-F.1 pairs: a flow driving its own session — no lease, or the pod's own lease — in the utility pod runs its turn; pod mode off is untouched (60.2 / 60.4)", async () => {
  await inWorld("f1pa", { place: "agent-pod", podMode: true }, async (world) => {
    const mock = mockClient();
    const before = snapshot(world.home);
    await directSend(mock.client);
    assert.equal(mock.prompts(), 1, "no lease: the turn ran");
    assert.notDeepEqual(snapshot(world.home), before, "and wrote its stream and record as today");
  });
  await inWorld("f1pb", { place: "agent-pod", podMode: true }, async (world) => {
    await writePodLease(world, SESSION); // the lease names THIS pod
    fs.writeFileSync(path.join(world.home, ".nv-agent"), `${world.pod.name}\n`);
    const mock = mockClient();
    await directSend(mock.client);
    assert.equal(mock.prompts(), 1, "the pod's own lease: the turn ran");
  });
  await inWorld("f1pc", { podMode: false }, async () => {
    const mock = mockClient();
    await directSend(mock.client);
    assert.equal(mock.prompts(), 1, "pod mode off, control host: today's direct send");
  });
});
