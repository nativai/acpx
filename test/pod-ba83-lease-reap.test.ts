import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { agentPodKey } from "../src/pod/routed-call.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { type ApiScript, startFakeApiServer } from "./pod-kit/fake-apiserver.js";
import { startFakeBroker } from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { makeBox, runCli } from "./umq-rig.js";

// brick ba830305 (FT-01a(3), A-32): a replacement pod's owner cannot reap its predecessor's lease — an agent pod
// never asks the API server (C3.3 A-4) — so the lease of a SIGKILLed in-pod owner must be reaped by the CONTROL
// pod's judgement. Nothing on the control pod performed it for a session whose pod was replaced: the continue is an
// ordinary `prompt` that `routed-ensure` runs inside the NEW pod, which sees a lease it "cannot tell" and answers
// "owner runs in another pid namespace … retry" for ever. The rig: the real CLI on a pod-mode control pod, the
// kit's fake API server (the old pod gone, a replacement Ready) and broker, a stub transport.

const SESSION = "8b03f1b1-bfee-4287-a415-8ac86e818c82";
const KEY = agentPodKey(SESSION);
const OLD = {
  name: `ag-${KEY}-qj52n`,
  uid: "045846d7-6019-4bb8-89e3-df8170ef55e7",
  node: "node-old",
};
const NEW_UID = "40f97190-0000-4000-8000-000000000001";
const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const STALE_AT = (): string => new Date(Date.now() - 600_000).toISOString();

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
`;

type Plant = {
  heartbeatAt?: string;
  /** What the lease says about its pod: the readable A-72 shape, a key that names no pod (A-68), or raw bytes (A-69). */
  pod?: "old" | "unreadable";
  raw?: string;
};

type Options = {
  plant: Plant;
  /** The API server: is the old pod gone and its node Ready (the proof's `gone`), still there, or silent. */
  api: "old-gone" | "old-exists" | "unknown";
  verb?: string[];
};

async function run(options: Options) {
  const f = makeBox({ requestMib: 4000 });
  const sessions = path.join(f.root, ".acpx", "sessions");
  fs.writeFileSync(
    path.join(sessions, `${SESSION}.json`),
    `${JSON.stringify(
      serializeSessionRecordForDisk(
        makeSessionRecord({
          acpxRecordId: SESSION,
          acpSessionId: `acp-${SESSION}`,
          agentCommand: CLAUDE,
          cwd: f.root,
        }),
      ),
    )}\n`,
  );
  const leaseFile = queueLockFilePath(SESSION, f.root);
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
  const body = {
    pid: 334,
    sessionId: SESSION,
    socketPath: `/run/acpx/q/${KEY}.sock`,
    createdAt: "2026-11-24T22:00:54.294Z",
    heartbeatAt: options.plant.heartbeatAt ?? STALE_AT(),
    ownerGeneration: 243904598762653,
    queueDepth: 0,
    host: `ag-${KEY}`,
    ...(options.plant.pod === "unreadable"
      ? { pod: "this-names-no-pod" }
      : { pod: { ...OLD, namespace: "dev-podlab" } }),
    placement: "home",
    routedContract: 1,
  };
  fs.writeFileSync(leaseFile, options.plant.raw ?? `${JSON.stringify(body, null, 2)}\n`);
  const leaseBefore = fs.readFileSync(leaseFile, "utf8");

  const replacement = {
    name: `ag-${KEY}-r2vnp`,
    uid: NEW_UID,
    podIP: "10.9.8.7",
    readyTransitionTime: "2026-11-24T22:02:09Z",
    labels: { "workbench.nativai.de/session-key": KEY },
  };
  const script: ApiScript = {
    namespace: "dev-podlab",
    token: "tok-1",
    pods:
      options.api === "old-exists"
        ? [
            {
              name: OLD.name,
              uid: OLD.uid,
              node: OLD.node,
              labels: { "workbench.nativai.de/session-key": KEY },
            },
            replacement,
          ]
        : [replacement],
    nodes: [{ name: OLD.node, ready: "True" }],
    ...(options.api === "unknown" ? { faults: [{ mode: "status", status: 500 }] } : {}),
  } as ApiScript;
  const api = await startFakeApiServer(script);
  const broker = await startFakeBroker({});
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-podlab\n");
  fs.writeFileSync(path.join(sa, "token"), "tok-1\n");
  const stubDir = fs.mkdtempSync(path.join(f.root, "stub-"));
  fs.writeFileSync(path.join(stubDir, "agent-exec"), STUB, { mode: 0o755 });
  const runtime = fs.mkdtempSync(path.join(f.root, "runtime-"));
  for (const tool of [
    "acpx",
    "acpx-ui",
    "claude-agent-acp",
    "codex-acp",
    "claude-pty-acp",
    "pi",
    "pi-acp",
  ]) {
    fs.mkdirSync(path.join(runtime, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(runtime, tool));
  }
  const env: NodeJS.ProcessEnv = {
    ...f.env,
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    ACPX_POD_API_URL: api.url,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
    NV_AGENT_BROKER_URL: broker.url,
    ACPX_AGENT_EXEC: path.join(stubDir, "agent-exec"),
    ACPX_TEST_RUNTIME_DIR: runtime,
  };
  const verb = options.verb ?? ["prompt", "--session-id", SESSION, "--no-wait", "continue"];
  const result = await runCli(["--agent", CLAUDE, "--approve-all", ...verb], env, "/workspace");
  const callsFile = path.join(stubDir, "calls.jsonl");
  return {
    result,
    /** The same call again on the same rig (the delivery's retry). */
    again: () => runCli(["--agent", CLAUDE, "--approve-all", ...verb], env, "/workspace"),
    leaseNow: () => fs.existsSync(leaseFile),
    calls: fs.existsSync(callsFile)
      ? fs.readFileSync(callsFile, "utf8").trim().split("\n").length
      : 0,
    leasePresent: fs.existsSync(leaseFile),
    leaseUnchanged: fs.existsSync(leaseFile) && fs.readFileSync(leaseFile, "utf8") === leaseBefore,
    close: async () => {
      await Promise.all([api.close(), broker.close()]);
    },
  };
}

async function withRun<T>(
  options: Options,
  check: (out: Awaited<ReturnType<typeof run>>) => T,
): Promise<T> {
  const out = await run(options);
  try {
    return await check(out);
  } finally {
    await out.close();
  }
}

test("ba83 RED · kill-inpod shape: a stale lease naming a pod the control proves GONE is reaped by the control before the continue is routed into the replacement pod — which is then called exactly once", async () => {
  await withRun({ plant: {}, api: "old-gone" }, (out) => {
    assert.equal(out.result.code, 0, out.result.stderr);
    assert.equal(out.calls, 1, "exactly one routed call into the replacement pod");
    assert.equal(
      out.leasePresent,
      false,
      "the dead predecessor's lease was reaped by the control pod's judgement",
    );
  });
});

test("ba83 · the same for an owner-if-pod command routed into the replacement pod (`cancel`)", async () => {
  await withRun(
    { plant: {}, api: "old-gone", verb: ["cancel", "--session-id", SESSION] },
    (out) => {
      assert.equal(out.result.code, 0, out.result.stderr);
      assert.equal(out.calls, 1);
      assert.equal(out.leasePresent, false);
    },
  );
});

test("ba83 NEGATIVES · a lease that is not PROVEN dead is never reaped: the old pod still exists; the heartbeat is fresh; the API server is silent", async () => {
  const cases: Array<[string, Options]> = [
    ["the old pod still exists (stale heartbeat)", { plant: {}, api: "old-exists" }],
    [
      "a fresh heartbeat (≤ 15 s), the old pod gone",
      { plant: { heartbeatAt: new Date().toISOString() }, api: "old-gone" },
    ],
    ["the API server answers 500 (the proof is `unknown`)", { plant: {}, api: "unknown" }],
  ];
  for (const [label, options] of cases) {
    await withRun(options, (out) => {
      assert.equal(out.leaseUnchanged, true, `${label}: the lease is untouched`);
    });
  }
});

test("ba83 NEGATIVES · the A-68 / A-69 held cases stay held: a `pod` key that names no pod; a lease acpx cannot parse", async () => {
  const cases: Array<[string, Options]> = [
    ["A-68: a pod key that names no pod", { plant: { pod: "unreadable" }, api: "old-gone" }],
    ["A-69: bytes that are not JSON", { plant: { raw: "{this is not json\n" }, api: "old-gone" }],
  ];
  for (const [label, options] of cases) {
    await withRun(options, (out) => {
      assert.equal(out.leaseUnchanged, true, `${label}: the lease is untouched`);
    });
  }
});

test("ba83 32.5 (the control side) · SIGKILL in the pod with a FRESH lease: the first call finds it standing and reaps nothing; the first call after the heartbeat goes stale is judged and reaped on the control pod — within 15 s of the heartbeat plus one retry interval", async () => {
  const startedAt = Date.now();
  // The owner died ~11 s ago: the heartbeat is 11 s old, so 4 s from now it is stale.
  await withRun(
    { plant: { heartbeatAt: new Date(startedAt - 11_000).toISOString() }, api: "old-gone" },
    async (out) => {
      assert.equal(
        out.leasePresent,
        true,
        "a FRESH predecessor lease is never reaped (no instant takeover)",
      );
      assert.equal(out.leaseUnchanged, true);
      const retryInterval = 5_000; // the delivery's retry cadence in this rig
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
      const second = await out.again();
      assert.equal(second.code, 0, second.stderr);
      assert.equal(
        out.leaseNow(),
        false,
        "the first call after the heartbeat went stale reaped the dead pod's lease on the control pod",
      );
      assert.ok(
        Date.now() - startedAt <= 11_000 + 15_000 + retryInterval + 5_000,
        "the new owner can start within 15 s of the heartbeat plus one retry interval",
      );
    },
  );
});
