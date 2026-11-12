// brick a0182aed — the same message id, sent again while the first copy is still CONNECTING, must reach the
// model ONCE.
//
// The realistic path (a0182aed STEP 1): the routed-prompt fallback (src/cli/routed-prompt.ts settleUnansweredSend).
// A POST to atrium that got no answer, followed by a status GET that atrium could not answer, makes the CLI
// deliver the message DIRECTLY under the delivery id — while atrium, which had stored it before it could answer,
// delivers its own copy under the same wire id. Both reach the same queue owner. The routed path relies on "the
// owner deduplicates the second copy by message id", and the owner did — but only once the first copy had
// COMPLETED: a second copy that arrived during the first copy's connect was sent to the model too (2
// `session/prompt`, the model answered twice; TE F2 on brick 6f461fe4, identical on production b9c4a3d4).
//
// ⚠️ REAL PROCESSES, a HELD connect. The window is the first copy's connect, so the adapter's `initialize` is held on
// a file (`--initialize-hold-file`) until both copies are in the owner's hands: deterministic under any load.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";
import { removeTempHome } from "./temp-home.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CLOSE_DRAIN_TIMEOUT_MS = "500";
const WAIT_MS = 60_000;

type CliRunResult = { code: number | null; stdout: string; stderr: string };

type Rig = {
  homeDir: string;
  cwd: string;
  /** While this file exists, every adapter's `initialize` waits (the rows that hold the connect). */
  holdFile: string;
  cli: (args: string[]) => Promise<CliRunResult>;
};

function startProbeServer(): Promise<{ server: Server; url: string }> {
  const fiveHour: Record<string, string> = { "token-dflt": "0.95", "token-target": "0.1" };
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
      const utilization = fiveHour[token];
      if (utilization === undefined) {
        response.writeHead(500).end("{}");
        return;
      }
      response
        .writeHead(200, {
          "anthropic-ratelimit-unified-5h-utilization": utilization,
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
          "anthropic-ratelimit-unified-7d-reset": "1893456000",
        })
        .end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1/messages` });
    });
  });
}

async function runCli(
  rig: { homeDir: string; cwd: string; probeUrl: string },
  args: string[],
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: rig.homeDir,
      ACPX_STATE_HOME: rig.homeDir,
      ACPX_NO_CATALOGUE_WARM: "1",
      CLAUDE_MESSAGES_ENDPOINT: rig.probeUrl,
    };
    for (const key of Object.keys(env)) {
      // The launching agent's own session/subscription identity must not reach the rig.
      if (
        key.startsWith("ACPX_SESSION_") ||
        key.startsWith("ACPX_PARENT_") ||
        key.startsWith("ACPX_EFFECTIVE_") ||
        key.startsWith("ACPX_SEAT") ||
        key.startsWith("ACPX_BRICK") ||
        key === "ACPX_SUBSCRIPTION" ||
        key === "ACPX_SUBSCRIPTION_AUTO_SELECT" ||
        key === "ACPX_OWNER_LOG" ||
        key === "ACPX_TASK_FOLDER" ||
        key === "CLAUDE_CONFIG_DIR"
      ) {
        delete env[key];
      }
    }
    scopeHarnessConfigDirRootForCli(args, env, rig.homeDir);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: rig.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-turn-cut-"));
  const { server, url } = await startProbeServer();
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const holdFile = path.join(homeDir, "hold-initialize");
    const command = [
      "node",
      adapterPath,
      "--claude-agent-acp",
      "--supports-load-session",
      "--initialize-hold-file",
      holdFile,
    ].join(" ");
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
    );
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    for (const id of ["dflt", "target"]) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
      await fs.writeFile(
        path.join(subsDir, id, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: `token-${id}` } }),
      );
    }
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify({
        version: 3,
        default: "dflt",
        profiles: ["dflt", "target"].map((id) => ({
          id,
          label: id,
          authMode: "subscription",
          adapter: "claude",
          account: `${id}-account`,
          credentialSource: path.join(subsDir, id),
        })),
      }),
      { mode: 0o600 },
    );
    const base = { homeDir, cwd, probeUrl: url };
    await run({ homeDir, cwd, holdFile, cli: async (args) => await runCli(base, args) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempHome(homeDir);
  }
}

function sessionFile(rig: Rig, id: string, suffix: string): string {
  return path.join(rig.homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}${suffix}`);
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, "utf8").catch(() => "");
}

function frames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function newSession(rig: Rig, options: { autoSubscription: boolean }): Promise<string> {
  const created = await rig.cli(["--format", "json", "claude", "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId);
  if (!options.autoSubscription) {
    const off = await rig.cli(["claude", "set", "auto-subscription", "off", "--session-id", id]);
    assert.equal(off.code, 0, off.stderr);
  }
  return id;
}

async function diagnose(rig: Rig, id: string): Promise<string> {
  return (
    `owner.log:\n${await readText(sessionFile(rig, id, ".owner.log"))}\n` +
    `stream:\n${await readText(sessionFile(rig, id, ".stream.ndjson"))}\n` +
    `messages:\n${await readText(sessionFile(rig, id, ".messages.ndjson"))}`
  );
}

// How often the nonce reached the adapter: its OCCURRENCES across every outbound `session/prompt`. Counted on the
// text, not on frames or `params.messageId`, so a second copy folded into ONE batch prompt is counted too.
function nonceSends(stream: string, nonce: string): number {
  return frames(stream)
    .filter((frame) => frame.method === "session/prompt")
    .reduce((count, frame) => count + JSON.stringify(frame.params).split(nonce).length - 1, 0);
}

function receivedCount(stream: string, messageId: string): number {
  return frames(stream).filter(
    (frame) =>
      frame.method === "acpx/received" &&
      (frame.params as { messageId?: unknown } | undefined)?.messageId === messageId,
  ).length;
}

function userRowCount(messagesLog: string, messageId: string): number {
  return frames(messagesLog).filter(
    (row) => (row.User as { id?: unknown } | undefined)?.id === messageId,
  ).length;
}

// The routed CLI's direct copy: waits for the turn (src/cli/routed-prompt.ts → the direct send).
function sendWaiting(rig: Rig, id: string, messageId: string, text: string) {
  return rig.cli([
    "--approve-all",
    "claude",
    "prompt",
    "--session-id",
    id,
    "--message-id",
    messageId,
    text,
  ]);
}

// atrium's runner copy: `prompt --no-wait --message-id` (acpx-ui server/promptInvocation.ts).
function sendNoWait(rig: Rig, id: string, messageId: string, text: string) {
  return rig.cli([
    "--approve-all",
    "claude",
    "prompt",
    "--no-wait",
    "--session-id",
    id,
    "--message-id",
    messageId,
    text,
  ]);
}

async function streamOf(rig: Rig, id: string): Promise<string> {
  return await readText(sessionFile(rig, id, ".stream.ndjson"));
}

async function waitForTurnIdle(rig: Rig, id: string): Promise<void> {
  await waitFor(async () => {
    const turns = frames(await streamOf(rig, id)).filter((frame) => frame.method === "acpx/turn");
    const last = turns.at(-1)?.params as { phase?: unknown } | undefined;
    return last?.phase === "idle";
  }, "the turn to end");
}

// Both copies of one id in the owner's hands while the first copy's connect is held; then release it.
async function twoCopiesDuringConnect(
  rig: Rig,
  order: "direct-first" | "runner-first",
): Promise<{ id: string; messageId: string; nonce: string; waited: CliRunResult }> {
  const id = await newSession(rig, { autoSubscription: false });
  const messageId = randomUUID();
  const nonce = `nonce-${randomUUID()}`;
  const text = `echo ${nonce}`;
  await fs.writeFile(rig.holdFile, "");
  let waiting: Promise<CliRunResult>;
  if (order === "direct-first") {
    waiting = sendWaiting(rig, id, messageId, text);
    await waitFor(
      async () => receivedCount(await streamOf(rig, id), messageId) >= 1,
      "copy 1 received",
    );
    const queued = await sendNoWait(rig, id, messageId, text);
    assert.equal(queued.code, 0, `${queued.stdout}\n${queued.stderr}`);
  } else {
    const queued = await sendNoWait(rig, id, messageId, text);
    assert.equal(queued.code, 0, `${queued.stdout}\n${queued.stderr}`);
    await waitFor(
      async () => receivedCount(await streamOf(rig, id), messageId) >= 1,
      "copy 1 received",
    );
    waiting = sendWaiting(rig, id, messageId, text);
  }
  await waitFor(
    async () => receivedCount(await streamOf(rig, id), messageId) >= 2,
    "copy 2 received",
  );
  // Precondition: the first copy is still connecting — nothing has reached the adapter yet.
  assert.equal(nonceSends(await streamOf(rig, id), nonce), 0, "precondition: still connecting");
  await fs.rm(rig.holdFile, { force: true });
  const waited = await waiting;
  await waitForTurnIdle(rig, id);
  // Let anything a second copy would still start reach the stream.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return { id, messageId, nonce, waited };
}

async function assertReachedModelOnce(
  rig: Rig,
  run: { id: string; messageId: string; nonce: string; waited: CliRunResult },
): Promise<void> {
  const stream = await streamOf(rig, run.id);
  const messagesLog = await readText(sessionFile(rig, run.id, ".messages.ndjson"));
  assert.equal(
    run.waited.code,
    0,
    `${run.waited.stdout}\n${run.waited.stderr}\n${await diagnose(rig, run.id)}`,
  );
  assert.equal(
    nonceSends(stream, run.nonce),
    1,
    `one message id, ONE session/prompt to the model\n${await diagnose(rig, run.id)}`,
  );
  assert.equal(userRowCount(messagesLog, run.messageId), 1, "one message id, one User row");
  // Each copy (request id) ends `done`: the deferred one as the dedup of the first, never as a failure.
  const byRequest = new Map<string, string[]>();
  for (const frame of frames(stream)) {
    const params = frame.params as
      | { messageId?: unknown; requestId?: unknown; phase?: unknown; stopReason?: unknown }
      | undefined;
    if (frame.method !== "acpx/delivery" || params?.messageId !== run.messageId) {
      continue;
    }
    const key = String(params.requestId);
    byRequest.set(key, [
      ...(byRequest.get(key) ?? []),
      `${String(params.phase)}/${String(params.stopReason)}`,
    ]);
  }
  assert.equal(
    byRequest.size,
    2,
    `both copies have delivery events\n${JSON.stringify([...byRequest])}`,
  );
  for (const [requestId, phases] of byRequest) {
    assert.ok(
      phases.some((phase) => phase.startsWith("done/")),
      `copy ${requestId} ends done: ${phases.join(", ")}`,
    );
    assert.ok(
      !phases.some((phase) => phase.startsWith("failed/")),
      `copy ${requestId}: ${phases.join(", ")}`,
    );
  }
}

test("routed fallback overlap — the direct copy connects, atrium's copy of the same id arrives: the model gets it once", async () => {
  await withRig(async (rig) => {
    const run = await twoCopiesDuringConnect(rig, "direct-first");
    try {
      await assertReachedModelOnce(rig, run);
    } finally {
      await rig.cli(["claude", "sessions", "close", "--session-id", run.id]);
    }
  });
});

test("routed fallback overlap, reversed — atrium's copy connects, the direct copy of the same id arrives: once", async () => {
  await withRig(async (rig) => {
    const run = await twoCopiesDuringConnect(rig, "runner-first");
    try {
      await assertReachedModelOnce(rig, run);
    } finally {
      await rig.cli(["claude", "sessions", "close", "--session-id", run.id]);
    }
  });
});

test("control — a re-drive of the same id after a FAILED first attempt still reaches the model exactly once", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: false });
    const messageId = randomUUID();
    const nonce = `nonce-${randomUUID()}`;
    try {
      // Attempt 1: cut by a close inside its connect — never reached the model (brick 6f461fe4).
      await fs.writeFile(rig.holdFile, "");
      const first = sendWaiting(rig, id, messageId, `echo ${nonce}`);
      await waitFor(
        async () => receivedCount(await streamOf(rig, id), messageId) >= 1,
        "attempt 1 received",
      );
      const closed = await rig.cli([
        "claude",
        "sessions",
        "close",
        "--session-id",
        id,
        "--drain-timeout",
        CLOSE_DRAIN_TIMEOUT_MS,
      ]);
      assert.equal(closed.code, 0, `${closed.stdout}\n${closed.stderr}`);
      await first;
      await fs.rm(rig.holdFile, { force: true });
      assert.equal(
        nonceSends(await streamOf(rig, id), nonce),
        0,
        "attempt 1 never reached the model",
      );

      // The re-drive (Reopen & resend), same id.
      const reopened = await rig.cli(["claude", "sessions", "reopen", id]);
      assert.equal(reopened.code, 0, `${reopened.stdout}\n${reopened.stderr}`);
      const redriven = await sendWaiting(rig, id, messageId, `echo ${nonce}`);
      assert.equal(
        redriven.code,
        0,
        `${redriven.stdout}\n${redriven.stderr}\n${await diagnose(rig, id)}`,
      );
      assert.match(redriven.stdout, new RegExp(nonce, "u"), "the agent answered the re-drive");
      assert.equal(nonceSends(await streamOf(rig, id), nonce), 1, await diagnose(rig, id));
      assert.equal(
        userRowCount(await readText(sessionFile(rig, id, ".messages.ndjson")), messageId),
        1,
      );
    } finally {
      await rig.cli(["claude", "sessions", "close", "--session-id", id]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TE F1 (a0182aed): a close while a copy is DEFERRED. The deferred copy of an id that already reached the model
// (accepted into the running turn, or done) must settle as `done / deduplicated`, never as `failed /
// SESSION_CLOSED_UNDELIVERED`, and the close must not list the id as "NOT delivered … safe to resend". A deferred
// copy whose id never reached the model keeps SESSION_CLOSED_UNDELIVERED (C4a).
// ---------------------------------------------------------------------------------------------------------------

function phasesByRequest(stream: string, messageId: string): Map<string, string[]> {
  const byRequest = new Map<string, string[]>();
  for (const frame of frames(stream)) {
    const params = frame.params as
      | {
          messageId?: unknown;
          requestId?: unknown;
          phase?: unknown;
          stopReason?: unknown;
          error?: { detailCode?: unknown };
        }
      | undefined;
    if (frame.method !== "acpx/delivery" || params?.messageId !== messageId) {
      continue;
    }
    const key = String(params.requestId);
    const detail = typeof params.error?.detailCode === "string" ? params.error.detailCode : "";
    byRequest.set(key, [
      ...(byRequest.get(key) ?? []),
      `${String(params.phase)}/${String(params.stopReason)}${detail ? `/${detail}` : ""}`,
    ]);
  }
  return byRequest;
}

// Copy 1 is MID-TURN (its `session/prompt` went out); copy 2 of the same id arrives and is deferred; then close.
async function closeWhileCopyDeferred(
  rig: Rig,
  drainTimeoutMs: string,
  // Copy 1 must still be running when copy 2 arrives (C4c) and when the close starts (C4b): under load a 4 s turn
  // ended first in both (gate and targeted runs), so both rows pass a longer one.
  text = "sleep 4137",
): Promise<{ id: string; messageId: string; text: string; close: CliRunResult; stream: string }> {
  const id = await newSession(rig, { autoSubscription: false });
  const messageId = randomUUID();
  const first = sendWaiting(rig, id, messageId, text);
  // `accepted`, not the `session/prompt` frame: delivery events are written at once, while the turn's ACP
  // frames reach the stream file only at a checkpoint or the turn's end (brick 6f461fe4, residual 1).
  await waitFor(
    async () =>
      [...phasesByRequest(await streamOf(rig, id), messageId).values()].some((phases) =>
        phases.some((phase) => phase.startsWith("accepted/")),
      ),
    "copy 1 mid-turn (accepted)",
  );
  const queued = await sendNoWait(rig, id, messageId, text);
  assert.equal(queued.code, 0, `${queued.stdout}\n${queued.stderr}`);
  try {
    await waitFor(async () => {
      const byRequest = phasesByRequest(await streamOf(rig, id), messageId);
      return [...byRequest.values()].some(
        (phases) => phases.length > 0 && phases.every((p) => p.startsWith("queued/")),
      );
    }, "copy 2 deferred (queued)");
  } catch (error) {
    throw new Error(`${String(error)}\n${await diagnose(rig, id)}`, { cause: error });
  }
  const close = await rig.cli([
    "claude",
    "sessions",
    "close",
    "--session-id",
    id,
    "--drain-timeout",
    drainTimeoutMs,
  ]);
  await first;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return { id, messageId, text, close, stream: await streamOf(rig, id) };
}

function assertDeferredCopySettledDelivered(run: {
  messageId: string;
  text: string;
  close: CliRunResult;
  stream: string;
}): void {
  const diag = `close stderr:\n${run.close.stderr}\nstream deliveries:\n${JSON.stringify([...phasesByRequest(run.stream, run.messageId)])}`;
  // At most once: when the close cuts the turn (C4b) the owner dies before its buffered ACP frames reach the
  // stream, so the one send may be unrecorded (brick 6f461fe4, residual 1). C4c asserts exactly one.
  assert.ok(nonceSends(run.stream, run.text) <= 1, `the model read it at most once\n${diag}`);
  const byRequest = phasesByRequest(run.stream, run.messageId);
  assert.equal(byRequest.size, 2, `both copies have delivery events\n${diag}`);
  const deferred = [...byRequest.values()].find(
    (phases) => !phases.some((p) => p.startsWith("accepted/")),
  );
  assert.ok(deferred, `one copy was never accepted (the deferred one)\n${diag}`);
  assert.ok(
    deferred.some((p) => p === "done/deduplicated"),
    `the deferred copy settles done/deduplicated\n${diag}`,
  );
  assert.ok(!deferred.some((p) => p.startsWith("failed/")), `never failed\n${diag}`);
  assert.ok(
    !run.close.stderr.includes(`NOT delivered: ${run.messageId}`),
    `the close must not call a message the agent read "NOT delivered"\n${diag}`,
  );
}

test("F1 C4c — copy 1 completes while copy 2 is deferred, then the close: copy 2 is done/deduplicated, not 'NOT delivered'", async () => {
  await withRig(async (rig) => {
    const run = await closeWhileCopyDeferred(rig, "60000", "sleep 12137");
    const first = [...phasesByRequest(run.stream, run.messageId).values()].find((p) =>
      p.some((phase) => phase.startsWith("accepted/")),
    );
    assert.ok(
      first?.includes("done/end_turn"),
      `precondition: copy 1 completed on its own: ${JSON.stringify(first)}`,
    );
    assert.equal(
      nonceSends(run.stream, run.text),
      1,
      "C4c: the completed turn's one send is recorded",
    );
    assertDeferredCopySettledDelivered(run);
  });
});

test("F1 C4b — the close cuts copy 1's turn while copy 2 is deferred: copy 2 is done/deduplicated, not failed", async () => {
  await withRig(async (rig) => {
    const run = await closeWhileCopyDeferred(rig, CLOSE_DRAIN_TIMEOUT_MS, "sleep 20137");
    const first = [...phasesByRequest(run.stream, run.messageId).values()].find((p) =>
      p.some((phase) => phase.startsWith("accepted/")),
    );
    assert.ok(
      first?.some((phase) => phase.startsWith("done/delivered_at_close")),
      `precondition: the close cut copy 1's turn (e50e171d): ${JSON.stringify(first)}`,
    );
    assertDeferredCopySettledDelivered(run);
  });
});

test("F1 C4a control — copy 1 cut inside its connect, copy 2 deferred: copy 2 stays SESSION_CLOSED_UNDELIVERED", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: false });
    const messageId = randomUUID();
    const text = `echo nonce-${randomUUID()}`;
    await fs.writeFile(rig.holdFile, "");
    const first = sendWaiting(rig, id, messageId, text);
    await waitFor(
      async () => receivedCount(await streamOf(rig, id), messageId) >= 1,
      "copy 1 received",
    );
    const queued = await sendNoWait(rig, id, messageId, text);
    assert.equal(queued.code, 0, `${queued.stdout}\n${queued.stderr}`);
    await waitFor(
      async () => receivedCount(await streamOf(rig, id), messageId) >= 2,
      "copy 2 received",
    );
    const close = await rig.cli([
      "claude",
      "sessions",
      "close",
      "--session-id",
      id,
      "--drain-timeout",
      CLOSE_DRAIN_TIMEOUT_MS,
    ]);
    await first;
    await fs.rm(rig.holdFile, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stream = await streamOf(rig, id);
    const diag = `close stderr:\n${close.stderr}\nstream deliveries:\n${JSON.stringify([...phasesByRequest(stream, messageId)])}`;
    assert.equal(nonceSends(stream, text), 0, `nothing reached the model\n${diag}`);
    const all = new Set([...phasesByRequest(stream, messageId).values()].flat());
    assert.ok(
      all.has("failed/null/SESSION_CLOSED_UNDELIVERED"),
      `a copy that never reached the model stays SESSION_CLOSED_UNDELIVERED\n${diag}`,
    );
    assert.ok(!all.has("done/deduplicated"), `never deduplicated against nothing\n${diag}`);
    assert.ok(
      close.stderr.includes(`NOT delivered: ${messageId}`),
      `the close still names it\n${diag}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TE F3 (a0182aed, case C6): a user CANCEL while a copy is deferred. Nothing may run after the cancel: the deferred
// copy must not start a new turn (the defer-and-requeue used to re-run it 0.6 s after the cancel, a second read of
// the message). It settles `cancelled`, mirroring the copy the user stopped.
// ---------------------------------------------------------------------------------------------------------------

function turnActiveCount(stream: string): number {
  return frames(stream).filter(
    (frame) =>
      frame.method === "acpx/turn" &&
      (frame.params as { phase?: unknown } | undefined)?.phase === "active",
  ).length;
}

test("F3 C6 — a user cancel while a copy is deferred: no turn runs after the cancel, the copy settles cancelled", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: false });
    const messageId = randomUUID();
    const text = "sleep 20137";
    try {
      const first = sendWaiting(rig, id, messageId, text);
      await waitFor(
        async () =>
          [...phasesByRequest(await streamOf(rig, id), messageId).values()].some((phases) =>
            phases.some((phase) => phase.startsWith("accepted/")),
          ),
        "copy 1 mid-turn (accepted)",
      );
      const queued = await sendNoWait(rig, id, messageId, text);
      assert.equal(queued.code, 0, `${queued.stdout}\n${queued.stderr}`);
      await waitFor(async () => {
        const byRequest = phasesByRequest(await streamOf(rig, id), messageId);
        return [...byRequest.values()].some(
          (phases) => phases.length > 0 && phases.every((p) => p.startsWith("queued/")),
        );
      }, "copy 2 deferred (queued)");
      const cancelled = await rig.cli(["claude", "cancel", "--session-id", id]);
      assert.equal(cancelled.code, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
      await first;
      // A re-run would show up at once as a second `acpx/turn active` and copy 2's `accepted`.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const stream = await streamOf(rig, id);
      const byRequest = phasesByRequest(stream, messageId);
      const diag = `stream deliveries:\n${JSON.stringify([...byRequest])}`;
      const copy1 = [...byRequest.values()].find((p) =>
        p.some((phase) => phase.startsWith("accepted/")),
      );
      assert.ok(
        copy1?.some((phase) => phase.startsWith("cancelled/")),
        `precondition: the user's cancel ended copy 1\n${diag}`,
      );
      assert.equal(turnActiveCount(stream), 1, `no turn after the cancel\n${diag}`);
      assert.equal(
        nonceSends(stream, text),
        1,
        `no second session/prompt after the cancel\n${diag}`,
      );
      const copy2 = [...byRequest.values()].find(
        (p) => !p.some((phase) => phase.startsWith("accepted/")),
      );
      assert.ok(copy2, `copy 2 was never accepted\n${diag}`);
      assert.equal(copy2.at(-1), "cancelled/cancelled", `copy 2 settles cancelled\n${diag}`);
    } finally {
      await rig.cli(["claude", "sessions", "close", "--session-id", id]);
    }
  });
});
