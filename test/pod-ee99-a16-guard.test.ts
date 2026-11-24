import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { terminateQueueOwnerForSession } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { sessionKey } from "../src/pod/placement.js";
import { sessionBaseDir } from "../src/session/persistence/session-base-dir.js";
import { clearPods, putNode, putPod, startKitApi } from "./pod-kit-api-helpers.js";
import { makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";

// brick ee9980e3, A-79 row 79.4 — A-16's guard (the switch OFF) builds the same "stays queued" promise OUTSIDE
// the routed path. It chooses its sentence with the SAME helper as the routed branch (`refusalForCaller`):
// a shell's prompt is told NOT queued, a command with no message names none, atrium's delivery spawns
// (`--message-id`, `--batch-file`) keep the hold sentence. Nothing local starts or writes while the pod exists;
// once the pod is proven gone the same shell prompt starts a local owner (A-16).

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const TOKEN = (id: string) =>
  `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=${id}`;
const OLD_SENTENCE =
  "acpx: the session's agent pod is being replaced by a newer one. Nothing was run; the message stays queued and is delivered when the pod is ready.";
const STALE = "2026-01-01T00:00:00.000Z";
const BATCH = JSON.stringify({
  v: 1,
  messages: [
    { messageId: "11111111-1111-4111-8111-aaaaaaaaaaaa", prompt: [{ type: "text", text: "one" }] },
    { messageId: "22222222-2222-4222-8222-bbbbbbbbbbbb", prompt: [{ type: "text", text: "two" }] },
  ],
});

type Run = { status: number | null; stdout: string; stderr: string };

function run(env: NodeJS.ProcessEnv, cwd: string, args: string[], stdin = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--agent", `node ${MOCK_AGENT}`, ...args], {
      env,
      cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end(stdin);
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("ee99 79.4 · the switch off, the lease names an existing pod: a shell's prompt is NOT queued (queued:false); cancel names no message; atrium's --message-id and --batch-file keep the promise (queued:true); nothing local starts; a gone pod starts a local owner", async () => {
  const api = await startKitApi("dev-kit");
  try {
    const owner = makeWorld("ee99-a16");
    const control = makeWorld("ee99-a16-control");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...worldEnv(control, {
        place: "control",
        identity: false,
        extra: {
          ACPX_STATE_HOME: owner.home,
          ACPX_POD_SA_DIR: owner.saDir,
          ACPX_POD_API_URL: api.url,
        },
      }),
    };
    for (const name of Object.keys(env)) {
      if (
        name === "ACPX_DEFAULT_OWNER" ||
        name.startsWith("ACPX_PI_") ||
        name === "ACPX_SESSION_ROOT" ||
        name === "ACPX_SESSION_URL" ||
        name === "ACPX_SEAT_URL" ||
        name === "ACPX_SESSION_RECORD_ID" ||
        name.startsWith("ACPX_PARENT_")
      ) {
        delete env[name];
      }
    }
    const cwd = fs.mkdtempSync(path.join(owner.root, "cwd-"));
    const created = await run(env, cwd, [
      "--format",
      "json",
      "sessions",
      "new",
      "--name",
      "ee99a16",
    ]);
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
      created.stdout,
    )?.[1];
    assert.ok(
      id,
      `a session was created: ${created.stdout.slice(0, 300)} ${created.stderr.slice(0, 300)}`,
    );

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
    const body = {
      sessionId: id,
      pid: 999_999,
      socketPath: `/run/acpx/q/${sessionKey(id)}.sock`,
      createdAt: STALE,
      heartbeatAt: new Date().toISOString(),
      ownerGeneration: 7,
      queueDepth: 0,
      pod,
      placement: "pool",
      routedContract: 1,
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(body, null, 2)}\n`);
    putPod(api, podName, { uid: pod.uid, phase: "Running" });
    const leaseBefore = fs.readFileSync(lockPath, "utf8");
    const recordBefore = fs.readFileSync(recordFile, "utf8");
    const untouched = (label: string): void => {
      assert.equal(fs.readFileSync(lockPath, "utf8"), leaseBefore, `${label}: lease untouched`);
      assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, `${label}: record untouched`);
    };
    const QUEUE_WORDS = /message|queue|deliver/iu;

    // A shell's prompt (text and JSON): NOT queued.
    const shell = await run(
      env,
      cwd,
      ["prompt", "--no-wait", "--session-id", id, "-f", "-"],
      "hello",
    );
    assert.equal(shell.status, 75, shell.stderr);
    const [token, ...rest] = shell.stderr.split("\n").filter((line) => line.length > 0);
    assert.equal(token, TOKEN(id), "the token line is unchanged");
    assert.match(rest.join("\n"), /the message was NOT queued and NOT sent/u);
    assert.match(rest.join("\n"), /again in about 3 s/u);
    assert.match(rest.join("\n"), /send-message\.sh/u);
    assert.doesNotMatch(rest.join("\n"), /stays queued|is delivered when/u);
    untouched("shell prompt");
    const shellJson = await run(env, cwd, [
      "--format",
      "json",
      "prompt",
      "--no-wait",
      "--session-id",
      id,
      "hello",
    ]);
    assert.equal(shellJson.status, 75, shellJson.stderr);
    const shellData = (
      JSON.parse(shellJson.stdout.trim().split("\n").at(-1) ?? "{}") as {
        error: { data: Record<string, unknown> };
      }
    ).error.data;
    assert.equal(shellData.queued, false);
    assert.equal(shellData.tokenLine, TOKEN(id));
    untouched("shell prompt json");

    // cancel carries no message: names none, repeat the command.
    const cancel = await run(env, cwd, ["--format", "json", "cancel", "--session-id", id]);
    assert.equal(cancel.status, 75, cancel.stderr);
    const cancelData = (
      JSON.parse(cancel.stdout.trim().split("\n").at(-1) ?? "{}") as {
        error: { data: Record<string, unknown> };
      }
    ).error.data;
    assert.equal(cancelData.queued, false);
    assert.equal(cancelData.tokenLine, TOKEN(id));
    assert.match(String(cancelData.message), /repeat the command after about 3 s/u);
    assert.doesNotMatch(String(cancelData.message), QUEUE_WORDS);
    const cancelText = await run(env, cwd, ["cancel", "--session-id", id]);
    assert.equal(cancelText.status, 75);
    assert.doesNotMatch(cancelText.stderr.split("\n").slice(1).join("\n"), QUEUE_WORDS);
    untouched("cancel");

    // Atrium's two spawn shapes keep the promise.
    const runner = { ...env, ACPX_ADMISSION_CLASS: "delivery" }; // as atrium's runner sets it (A-79 / F-R3)
    const marked = await run(runner, cwd, [
      "--format",
      "json",
      "prompt",
      "--no-wait",
      "--session-id",
      id,
      "--message-id",
      "d00dfeed-0000-4000-8000-0000000000aa",
      "hello",
    ]);
    assert.equal(marked.status, 75, marked.stderr);
    assert.equal(marked.stderr.split("\n")[0], TOKEN(id));
    const markedData = (
      JSON.parse(marked.stdout.trim().split("\n").at(-1) ?? "{}") as {
        error: { data: Record<string, unknown> };
      }
    ).error.data;
    assert.equal(markedData.queued, true);
    assert.equal(markedData.message, OLD_SENTENCE);
    const batch = await run(
      runner,
      cwd,
      ["--format", "json", "prompt", "--no-wait", "--session-id", id, "--batch-file", "-"],
      BATCH,
    );
    assert.equal(batch.status, 75, batch.stderr);
    assert.equal(batch.stderr.split("\n")[0], TOKEN(id));
    const batchData = (
      JSON.parse(batch.stdout.trim().split("\n").at(-1) ?? "{}") as {
        error: { data: Record<string, unknown> };
      }
    ).error.data;
    assert.equal(batchData.queued, true);
    assert.equal(batchData.message, OLD_SENTENCE);
    untouched("atrium spawns");

    // Row 79.6 at this guard: the same marks passed by hand, without the runner's class, hold nothing.
    for (const [label, args, stdin] of [
      [
        "--message-id",
        [
          "prompt",
          "--no-wait",
          "--session-id",
          id,
          "--message-id",
          "d00dfeed-0000-4000-8000-0000000000bb",
          "hello",
        ],
        "",
      ],
      ["--batch-file", ["prompt", "--no-wait", "--session-id", id, "--batch-file", "-"], BATCH],
    ] as const) {
      const byHand = await run(env, cwd, ["--format", "json", ...args], stdin);
      assert.equal(byHand.status, 75, `${label}: ${byHand.stderr}`);
      const handData = (
        JSON.parse(byHand.stdout.trim().split("\n").at(-1) ?? "{}") as {
          error: { data: Record<string, unknown> };
        }
      ).error.data;
      assert.equal(handData.queued, false, label);
      assert.match(String(handData.message), /the message was NOT queued and NOT sent/u, label);
    }
    untouched("hand-passed marks");

    // The pair: the pod proven gone — the same shell prompt starts a local owner (A-16 allows it).
    clearPods(api);
    putNode(api, pod.node, "True");
    fs.writeFileSync(lockPath, `${JSON.stringify({ ...body, heartbeatAt: STALE }, null, 2)}\n`);
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
