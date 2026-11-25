import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src/acp/client.js";
import { tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { sendSessionDirect } from "../src/cli/session/runtime.js";
import { createQuietCaptureOutput } from "../src/flows/runtime-support.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { makeWorld, withEnv, worldEnv, type PodWorld, type WorldEnv } from "./pod-owner-helpers.js";
import { writeLeaseWithBadPod, writePodLease } from "./pod-proof-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Brick 59070d68, row C1.2-F.1 (CONTRACTS-r4 C1.2 "A flow's direct send"): `sendSessionDirect` refuses BEFORE it
// writes anything — no record write, no stream writer, no marker, no lock — (i) on a control-role host in pod mode,
// (ii) in an agent pod whose target session's lease is held elsewhere. The refusals are the existing ones.
// The function is called DIRECTLY, as an in-process caller of `acpx/flows` would (no CLI placement step).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type FlowsExport = {
  FlowRunner: new (options: Record<string, unknown>) => object;
};

/** The REAL package export: `exports["./flows"]` of package.json, which maps into `dist/` (needs `pnpm build`). */
async function loadFlowsExport(): Promise<FlowsExport> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  const mapped = path.join(REPO_ROOT, pkg.exports["./flows"] ?? "");
  assert.ok(
    mapped.endsWith(`${path.sep}dist${path.sep}flows.js`),
    "GUARD: the `acpx/flows` export maps into dist/flows.js",
  );
  return (await import(pathToFileURL(mapped).href)) as FlowsExport;
}

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
/** C7.2 `owner_outside_pod session=<record id>`, then the sentence that names the holder (exit 2). */
const outside = (holder: RegExp): RegExp =>
  new RegExp(`^acpx: REFUSED reason=owner_outside_pod session=${SESSION}\\n${holder.source}`);

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

async function refused(
  world: PodWorld,
  pattern: RegExp,
  why: string,
  exitCode?: number,
): Promise<void> {
  const { client, prompts } = mockClient();
  const before = snapshot(world.home);
  await assert.rejects(
    async () => await directSend(client),
    (error: Error) => {
      assert.match(error.message, pattern, why);
      assert.doesNotMatch(
        error.message,
        /file=/,
        `${why}: no new token value such as file=session`,
      );
      if (exitCode !== undefined) {
        assert.equal((error as { exitCode?: number }).exitCode, exitCode, `${why}: exit code`);
      }
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

/** This pod's place file is what `writePodLease` / a control-pod lease writer removes or lacks: put it back. */
function backInThePod(world: PodWorld): void {
  fs.writeFileSync(path.join(world.home, ".nv-agent"), `${world.pod.name}\n`);
}

test("C1.2-F.1 (ii): in the utility pod, a session whose lease is held elsewhere is refused before anything is written — all FOUR variants, with `owner_outside_pod session=<id>`, exit 2, and a sentence that names the holder", async () => {
  const variants: {
    name: string;
    holder: RegExp;
    lease: (world: PodWorld) => Promise<void>;
  }[] = [
    {
      name: "a POOL session: the lease names another pod",
      holder: /The session's lease is held by another pod\./,
      lease: async (world) => {
        await writePodLease({ ...makeWorld("f1iipo"), home: world.home }, SESSION);
      },
    },
    {
      name: "a HOME session: a home owner's lease without `pod`",
      holder: /The session's lease is held by a home owner on the control pod/,
      lease: async (world) => {
        // Written on the control pod: no place file, no pod identity, so no `pod` key.
        fs.rmSync(path.join(world.home, ".nv-agent"), { force: true });
        await withEnv(worldEnv(world, { podMode: false, identity: false }), async () => {
          assert.ok(await tryAcquireQueueOwnerLease(SESSION));
        });
      },
    },
    {
      name: "a lease that cannot be read",
      holder: /The session's lease cannot be read\./,
      lease: async (world) => {
        fs.mkdirSync(path.join(world.home, ".acpx", "queues"), { recursive: true });
        fs.writeFileSync(queueLockFilePath(SESSION, world.home), "{ not a lease");
      },
    },
    {
      name: "a lease whose `pod` key names no pod (A-68)",
      holder: /The session's lease names a pod that cannot be read\./,
      lease: async (world) => {
        await writeLeaseWithBadPod(
          { ...makeWorld("f1iipb"), home: world.home },
          SESSION,
          "ag-not-an-object",
        );
      },
    },
  ];
  for (const [index, variant] of variants.entries()) {
    await inWorld(`f1ii${index}`, { place: "agent-pod", podMode: true }, async (world) => {
      await variant.lease(world);
      backInThePod(world);
      await refused(world, outside(variant.holder), variant.name, 2);
    });
  }
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

test("C1.2-F.1 (i) through the LIBRARY EXPORT `acpx/flows` (dist/flows.js, the package's own export): a FlowRunner (an in-process caller, no CLI placement) on a pod-mode control pod is refused at its direct send before anything is written", async () => {
  const { FlowRunner } = await loadFlowsExport();
  await inWorld("f1lib", { podMode: true }, async (world) => {
    const { client, prompts } = mockClient();
    const runner = new FlowRunner({
      resolveAgent: () => ({
        agentName: "mock",
        agentCommand: "node mock-agent.js",
        cwd: world.home,
      }),
      permissionMode: "approve-all",
    });
    // The exported class's own path to the direct send: a flow node on an EXISTING session binding.
    const internals = runner as unknown as {
      pendingPersistentSessionClients: Map<string, AcpClient>;
      runPersistentPrompt: (
        runDir: string,
        state: object,
        binding: object,
        prompt: unknown,
      ) => Promise<unknown>;
    };
    const binding = { key: "lib-binding", acpxRecordId: SESSION, bundleId: "main" };
    internals.pendingPersistentSessionClients.set(binding.key, client);
    const before = snapshot(world.home);
    await assert.rejects(
      async () =>
        await internals.runPersistentPrompt(world.home, { sessionBindings: {} }, binding, [
          { type: "text", text: "hello" },
        ]),
      /reason=bridge_on_control_pod nothing_started=true protocol=1 what=adapter/,
    );
    assert.deepEqual(snapshot(world.home), before, "nothing of the session or its queue changed");
    assert.equal(prompts(), 0);
  });
});
