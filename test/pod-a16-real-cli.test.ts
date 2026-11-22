import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectToQueueOwner } from "../src/cli/queue/ipc-transport.js";
import { terminateQueueOwnerForSession } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { sessionKey } from "../src/pod/placement.js";
import { sessionBaseDir } from "../src/session/persistence/session-base-dir.js";
import { startFakeApi } from "./pod-lock-fake-api.js";
import { makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";

// Block A4 (brick 30df3a5b), A-16 through the REAL CLI (TE finding F4, brick 30df3a5b TE-7b): in local
// mode a session whose lease names a pod not proven gone answers `acpx: REFUSED reason=pod_starting …
// phase=turnover` (exit 75) BEFORE any socket attempt — for a pod that exists (fresh or stale
// heartbeat, i.e. a delete that failed) and for an API that does not answer. Lease and record bytes stay
// as they were; no local owner starts. Sandbox state home; fake API; the repo's mock agent.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const TOKEN =
  /^acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=/;
const STALE = "2026-01-01T00:00:00.000Z";

type Run = { status: number | null; stdout: string; stderr: string };

function cliEnv(
  stateHome: string,
  apiPatch: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(apiPatch)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  env.ACPX_STATE_HOME = stateHome;
  for (const name of Object.keys(env)) {
    // The box's own owner / pi / session-root settings must not steer a rig (the suite's scrub does the same).
    if (
      name === "ACPX_DEFAULT_OWNER" ||
      name.startsWith("ACPX_PI_") ||
      name === "ACPX_SESSION_ROOT"
    ) {
      delete env[name];
    }
  }
  return env;
}

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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("A-16 on the real CLI: prompt, cancel, set-mode and sessions close answer pod_starting turnover (75) for an existing pod, a failed delete and an unknown API; a gone pod wakes locally", async () => {
  const api = await startFakeApi("dev-kit");
  try {
    const owner = makeWorld("a16-cli");
    const control = makeWorld("a16-cli-control");
    const env = cliEnv(
      owner.home,
      worldEnv(control, {
        place: "control",
        identity: false,
        extra: {
          ACPX_STATE_HOME: owner.home,
          ACPX_POD_SA_DIR: owner.saDir,
          ACPX_POD_API_URL: api.url,
        },
      }),
    );
    const cwd = fs.mkdtempSync(path.join(owner.root, "cwd-"));
    const created = await run(env, cwd, [
      "--format",
      "json",
      "sessions",
      "new",
      "--name",
      "a16cli",
    ]);
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
      created.stdout,
    )?.[1];
    assert.ok(
      id,
      `a session was created: ${created.stdout.slice(0, 300)} ${created.stderr.slice(0, 300)}`,
    );
    // Positive control: today's local prompt answers before any pod lease exists.
    const control0 = await run(env, cwd, [
      "--format",
      "quiet",
      "prompt",
      "--session-id",
      id,
      "echo positive-control",
    ]);
    assert.equal(control0.status, 0, control0.stderr);
    await withEnv({ ACPX_STATE_HOME: owner.home, ACPX_POD_TEST_HOME: control.home }, async () => {
      await terminateQueueOwnerForSession(id);
    });

    // Plant the lease of an agent pod, in the C3.1 shape, in the sandbox state home.
    const podName = `ag-${sessionKey(id)}`;
    const pod = {
      name: podName,
      uid: "11111111-1111-4111-8111-111111111111",
      node: "n1",
      namespace: "dev-kit",
    };
    const lockPath = await withEnv({ ACPX_STATE_HOME: owner.home }, () => queueLockFilePath(id));
    const recordFile = await withEnv({ ACPX_STATE_HOME: owner.home }, () =>
      path.join(sessionBaseDir(), `${encodeURIComponent(id)}.json`),
    );
    const plant = (heartbeatAt: string): string => {
      const body = {
        sessionId: id,
        pid: 999_999,
        socketPath: `/run/acpx/q/${sessionKey(id)}.sock`,
        createdAt: STALE,
        heartbeatAt,
        ownerGeneration: 7,
        queueDepth: 0,
        pod,
        placement: "pool",
        routedContract: 1,
      };
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `${JSON.stringify(body, null, 2)}\n`);
      return fs.readFileSync(lockPath, "utf8");
    };
    const recordBefore = fs.readFileSync(recordFile, "utf8");

    const scenarios: { name: string; heartbeat: string; setup: () => void }[] = [
      {
        name: "pod exists, fresh heartbeat",
        heartbeat: new Date().toISOString(),
        setup: () => api.state.pods.set(podName, { uid: pod.uid, phase: "Running" }),
      },
      {
        name: "pod exists, stale heartbeat (its delete failed)",
        heartbeat: STALE,
        setup: () => api.state.pods.set(podName, { uid: pod.uid, phase: "Running" }),
      },
      {
        name: "API server unknown (500), stale heartbeat",
        heartbeat: STALE,
        setup: () => {
          api.state.pods.clear();
          api.state.failure = "500";
        },
      },
    ];
    for (const scenario of scenarios) {
      api.state.failure = undefined;
      scenario.setup();
      const leaseBefore = plant(scenario.heartbeat);
      for (const verb of [
        ["prompt", "--session-id", id, "echo should-not-run"],
        ["cancel", "--session-id", id],
        ["set-mode", "plan", "--session-id", id],
        // R2-1: `sessions close` writes `closed` / `closed_at` / pid fields — it is refused first.
        ["sessions", "close", "--session-id", id],
      ]) {
        const result = await run(env, cwd, verb);
        assert.equal(
          result.status,
          75,
          `${scenario.name} / ${verb[0]}: ${result.stderr.slice(0, 400)}`,
        );
        assert.match(result.stderr.split("\n")[0] ?? "", TOKEN, `${scenario.name} / ${verb[0]}`);
        assert.equal(
          fs.readFileSync(lockPath, "utf8"),
          leaseBefore,
          `${scenario.name}: lease untouched`,
        );
        assert.equal(
          fs.readFileSync(recordFile, "utf8"),
          recordBefore,
          `${scenario.name}: record untouched`,
        );
      }
    }

    // The pod is proven gone (no pod of the name, its node Ready): the wake proceeds locally.
    api.state.failure = undefined;
    api.state.pods.clear();
    api.state.nodes.set(pod.node, "True");
    plant(STALE);
    const gone = await run(env, cwd, [
      "--format",
      "quiet",
      "prompt",
      "--session-id",
      id,
      "echo after-gone",
    ]);
    assert.equal(gone.status, 0, gone.stderr);
    const lease = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    assert.equal("pod" in lease, false, "the new local lease names no pod");
    await withEnv({ ACPX_STATE_HOME: owner.home, ACPX_POD_TEST_HOME: control.home }, async () => {
      await terminateQueueOwnerForSession(id);
    });
  } finally {
    await api.close();
  }
});

test("A-16 backstop: connectToQueueOwner — the one door to an owner's socket — never connects to a pod's lease unless the pod is proven gone", async () => {
  const api = await startFakeApi("dev-kit");
  try {
    const owner = makeWorld("a16-door");
    const control = makeWorld("a16-door-control");
    const sock = path.join(owner.root, "door.sock");
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const lease = {
      pid: 1,
      sessionId: "door-session",
      socketPath: sock,
      createdAt: STALE,
      heartbeatAt: STALE,
      ownerGeneration: 1,
      queueDepth: 0,
      pod: { name: "ag-door", uid: "uid-door", node: "n-door", namespace: "dev-kit" },
    };
    const env = worldEnv(control, {
      place: "control",
      identity: false,
      extra: {
        ACPX_STATE_HOME: owner.home,
        ACPX_POD_SA_DIR: owner.saDir,
        ACPX_POD_API_URL: api.url,
      },
    });
    try {
      await withEnv(env, async () => {
        api.state.pods.set("ag-door", { uid: "uid-door", phase: "Running" });
        await assert.rejects(connectToQueueOwner(lease, 1), { stderrLine: TOKEN });
        assert.equal(connections, 0, "no socket attempt while the pod exists");
        api.state.pods.clear();
        api.state.failure = "500";
        await assert.rejects(connectToQueueOwner(lease, 1), { stderrLine: TOKEN });
        assert.equal(connections, 0, "no socket attempt while the proof is unknown");
        // Negative: a lease WITHOUT a pod field is today's — it connects, and the API is not asked.
        api.state.failure = undefined;
        api.state.requests.length = 0;
        const { pod: _pod, ...podless } = lease;
        const socket = await connectToQueueOwner(podless, 1);
        socket?.destroy();
        assert.equal(api.state.requests.length, 0);
        // The pod proven gone: the door opens.
        api.state.nodes.set("n-door", "True");
        (await connectToQueueOwner(lease, 1))?.destroy();
      });
      assert.ok(connections >= 2, "the podless lease and the gone pod both connected");
    } finally {
      server.close();
    }
  } finally {
    await api.close();
  }
});
