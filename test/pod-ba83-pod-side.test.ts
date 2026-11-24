import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { sessionKey } from "../src/pod/placement.js";
import { putNode, requestLines, startKitApi } from "./pod-kit-api-helpers.js";
import { makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";

// brick ba830305, A-32 + C3.1 row 32.5 — the CONDITION the control pod's route-time judgement rests on: a call that
// meets a predecessor's lease inside the REPLACEMENT pod is never ACCEPTED to wait there (exit 0) and never reaps it
// (an agent pod never asks the API server). It comes back retryable — "owner runs in another pid namespace … retry"
// — so that atrium's retry supplies the next judgement on the control pod. Real CLI standing in the replacement pod
// (the product's pod seams), the old pod's lease planted FRESH and then STALE, the API server one that must stay
// unasked.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type Run = { status: number | null; stdout: string; stderr: string };

function run(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--agent", `node ${MOCK_AGENT}`, ...args], {
      env,
      cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("ba83 32.5 (the condition) · in the REPLACEMENT pod a call meeting the predecessor's lease — fresh, then stale with the old pod provably gone — is never accepted (exit ≠ 0, retryable), never reaps it, and never asks the API server", async () => {
  const api = await startKitApi("dev-kit");
  try {
    const world = makeWorld("ba83-pod-side");
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(baseEnv)) {
      if (
        name === "ACPX_DEFAULT_OWNER" ||
        name.startsWith("ACPX_PI_") ||
        name === "ACPX_SESSION_ROOT"
      ) {
        delete baseEnv[name];
      }
    }
    const controlEnv = {
      ...baseEnv,
      ...worldEnv(world, {
        place: "control",
        identity: false,
        extra: {
          ACPX_STATE_HOME: world.home,
          ACPX_POD_SA_DIR: world.saDir,
          ACPX_POD_API_URL: api.url,
        },
      }),
    };
    const cwd = fs.mkdtempSync(path.join(world.root, "cwd-"));
    const created = await run(controlEnv, cwd, [
      "--format",
      "json",
      "sessions",
      "new",
      "--name",
      "ba83",
    ]);
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
      created.stdout,
    )?.[1];
    assert.ok(
      id,
      `a session was created: ${created.stdout.slice(0, 300)} ${created.stderr.slice(0, 300)}`,
    );

    // The predecessor's lease, in the C3.1 shape, in the (shared) state home: pod qj52n, uid OLD.
    const old = {
      name: `ag-${sessionKey(id)}-qj52n`,
      uid: "045846d7-6019-4bb8-89e3-df8170ef55e7",
      node: "node-old",
      namespace: "dev-kit",
    };
    const lockPath = await withEnv({ ACPX_STATE_HOME: world.home }, () => queueLockFilePath(id));
    const plant = (heartbeatAt: string): string => {
      const body = {
        sessionId: id,
        pid: 334,
        socketPath: `/run/acpx/q/${sessionKey(id)}.sock`,
        createdAt: "2026-11-24T22:00:54.294Z",
        heartbeatAt,
        ownerGeneration: 243904598762653,
        queueDepth: 0,
        host: `ag-${sessionKey(id)}`,
        pod: old,
        placement: "home",
        routedContract: 1,
      };
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `${JSON.stringify(body, null, 2)}\n`);
      return fs.readFileSync(lockPath, "utf8");
    };

    // The replacement pod: another uid, a name under the same key; the old pod and its node are provably gone/Ready.
    putNode(api, old.node, "True");
    api.reset();
    const replacementPod = {
      name: `ag-${sessionKey(id)}-r2vnp`,
      uid: "40f97190-0000-4000-8000-000000000001",
      node: "node-new",
      namespace: "dev-kit",
    };
    const replacement = {
      ...baseEnv,
      ...worldEnv(
        { ...world, pod: replacementPod },
        {
          place: "agent-pod",
          extra: {
            ACPX_STATE_HOME: world.home,
            ACPX_POD_SA_DIR: world.saDir,
            ACPX_POD_API_URL: api.url,
          },
        },
      ),
    };

    // The place file names the pod's hostname alias `ag-<key>` (the NV_POD_NAME carries the Job's suffix).
    fs.writeFileSync(path.join(world.home, ".nv-agent"), `ag-${sessionKey(id)}\n`);

    for (const [label, heartbeatAt] of [
      ["FRESH heartbeat", new Date().toISOString()],
      ["STALE heartbeat, the old pod provably gone", new Date(Date.now() - 600_000).toISOString()],
    ] as const) {
      const leaseBefore = plant(heartbeatAt);
      const result = await run(replacement, cwd, [
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "continue",
      ]);
      assert.notEqual(
        result.status,
        0,
        `${label}: the call was ACCEPTED into the replacement pod to wait (exit 0): ${result.stdout}`,
      );
      assert.match(
        result.stderr,
        /another pid namespace .* retry/u,
        `${label}: retryable, as atrium retries it: ${result.stderr.slice(0, 400)}`,
      );
      assert.equal(
        fs.readFileSync(lockPath, "utf8"),
        leaseBefore,
        `${label}: the pod side reaped nothing`,
      );
      assert.equal(requestLines(api).length, 0, `${label}: an agent pod never asks the API server`);
    }
  } finally {
    await api.close();
  }
});
