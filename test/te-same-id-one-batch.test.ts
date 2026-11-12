// TE probe for brick a0182aed (SELF-CHECK "Not covered"): copies of ONE message id queued behind a busy, unrelated
// turn, so they reach the owner's pending queue and are taken as ONE batch at the next turn start. The fix's batch
// filter (runSessionPrompt → deferInFlightCopies on `options.batch`, in place) is the only thing that keeps the
// second copy out of that batch's single `session/prompt`.
//
// The agent is the mock under a NON-claude, NON-codex command: no mid-turn injection, so what arrives during the
// busy turn queues (a claude command would inject it instead, which is a different path).
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTempHome } from "./temp-home.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const WAIT_MS = 60_000;
const AGENT = "teqmock";

type CliRunResult = { code: number | null; stdout: string; stderr: string };
type Rig = { homeDir: string; cwd: string; cli: (args: string[]) => Promise<CliRunResult> };

function runCli(rig: { homeDir: string; cwd: string }, args: string[]): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: rig.homeDir,
      ACPX_STATE_HOME: rig.homeDir,
      ACPX_NO_CATALOGUE_WARM: "1",
    };
    for (const key of Object.keys(env)) {
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-te-one-batch-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    const command = ["node", MOCK_AGENT_PATH, "--supports-load-session"].join(" ");
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { [AGENT]: { command } } }, null, 2)}\n`,
    );
    const base = { homeDir, cwd };
    await run({ homeDir, cwd, cli: async (args) => await runCli(base, args) });
  } finally {
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

function phasesByRequest(stream: string, messageId: string): Map<string, string[]> {
  const byRequest = new Map<string, string[]>();
  for (const frame of frames(stream)) {
    const params = frame.params as
      | { messageId?: unknown; requestId?: unknown; phase?: unknown; stopReason?: unknown }
      | undefined;
    if (frame.method !== "acpx/delivery" || params?.messageId !== messageId) {
      continue;
    }
    const key = String(params.requestId);
    byRequest.set(key, [
      ...(byRequest.get(key) ?? []),
      `${String(params.phase)}/${String(params.stopReason)}`,
    ]);
  }
  return byRequest;
}

function allDone(byRequest: Map<string, string[]>, copies: number): boolean {
  return (
    byRequest.size === copies &&
    [...byRequest.values()].every((phases) =>
      phases.some((phase) => phase.startsWith("done/") || phase.startsWith("failed/")),
    )
  );
}

async function newSession(rig: Rig): Promise<string> {
  const created = await rig.cli(["--format", "json", AGENT, "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  return String((JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId);
}

function noWait(rig: Rig, id: string, messageId: string, text: string) {
  return rig.cli([
    "--approve-all",
    AGENT,
    "prompt",
    "--no-wait",
    "--session-id",
    id,
    "--message-id",
    messageId,
    text,
  ]);
}

async function diagnose(rig: Rig, id: string): Promise<string> {
  return (
    `owner.log:\n${await readText(sessionFile(rig, id, ".owner.log"))}\n` +
    `stream:\n${await readText(sessionFile(rig, id, ".stream.ndjson"))}\n` +
    `messages:\n${await readText(sessionFile(rig, id, ".messages.ndjson"))}`
  );
}

async function copiesBehindBusyTurn(copies: number): Promise<void> {
  await withRig(async (rig) => {
    const id = await newSession(rig);
    const streamOf = async () => await readText(sessionFile(rig, id, ".stream.ndjson"));
    try {
      // The busy, unrelated turn.
      const t0 = Date.now();
      const marks: string[] = [];
      const busy = rig.cli(["--approve-all", AGENT, "prompt", "--session-id", id, "sleep 30000"]);
      let busyDone: CliRunResult | undefined;
      void busy.then((r) => (busyDone = r));
      await waitFor(
        async () =>
          frames(await streamOf()).some(
            (f) =>
              f.method === "acpx/turn" && (f.params as { phase?: unknown })?.phase === "active",
          ),
        "the busy turn's prompt",
      );
      // The session/prompt frame reaches the stream late; the turn is active, give its connect a moment.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      marks.push(`turn-active@${Date.now() - t0}`);
      const messageId = randomUUID();
      const nonce = `nonce-${randomUUID()}`;
      const otherId = randomUUID();
      const otherNonce = `other-${randomUUID()}`;
      for (let i = 0; i < copies; i++) {
        const queued = await noWait(rig, id, messageId, `echo ${nonce}`);
        assert.equal(queued.code, 0, `${queued.stdout}\n${queued.stderr}`);
        marks.push(`copy${i}@${Date.now() - t0}`);
      }
      const other = await noWait(rig, id, otherId, `echo ${otherNonce}`);
      assert.equal(other.code, 0, `${other.stdout}\n${other.stderr}`);
      // Precondition: every copy is in the owner's hands, nothing of them sent, the busy turn still running.
      const before = await streamOf();
      assert.equal(
        busyDone,
        undefined,
        `precondition: the busy turn is still running ${marks.join(" ")} now@${Date.now() - t0} ${JSON.stringify(busyDone)}`,
      );
      assert.equal(receivedCount(before, messageId), copies, "precondition: all copies received");
      assert.equal(
        nonceSends(before, nonce),
        0,
        `precondition: none sent yet\n${await diagnose(rig, id)}`,
      );
      assert.equal(nonceSends(before, otherNonce), 0, "precondition: other not sent yet");
      const busyResult = await busy;
      assert.equal(busyResult.code, 0, busyResult.stderr);
      await waitFor(
        async () => allDone(phasesByRequest(await streamOf(), messageId), copies),
        "every copy settled",
      );
      await waitFor(
        async () => allDone(phasesByRequest(await streamOf(), otherId), 1),
        "the other message settled",
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const stream = await streamOf();
      const messagesLog = await readText(sessionFile(rig, id, ".messages.ndjson"));
      const diag = await diagnose(rig, id);
      // The batch really was ONE batch: the other message and the first copy rode one session/prompt.
      const batchPrompt = frames(stream).find(
        (f) =>
          f.method === "session/prompt" &&
          JSON.stringify(f.params).includes(nonce) &&
          JSON.stringify(f.params).includes(otherNonce),
      );
      assert.ok(batchPrompt, `subject: the copies and the other message formed ONE batch\n${diag}`);
      assert.equal(nonceSends(stream, nonce), 1, `one id, one send to the model\n${diag}`);
      assert.equal(nonceSends(stream, otherNonce), 1, `the other id still sent once\n${diag}`);
      assert.equal(userRowCount(messagesLog, messageId), 1, "one User row for the id");
      assert.equal(userRowCount(messagesLog, otherId), 1, "one User row for the other id");
      const byRequest = phasesByRequest(stream, messageId);
      const settled = [...byRequest.values()].map((phases) => phases.at(-1));
      assert.equal(
        settled.filter((s) => s === "done/deduplicated").length,
        copies - 1,
        `every extra copy ends done/deduplicated: ${JSON.stringify([...byRequest])}`,
      );
      assert.ok(
        ![...byRequest.values()].flat().some((p) => p.startsWith("failed/")),
        `no copy failed: ${JSON.stringify([...byRequest])}`,
      );
    } finally {
      await rig.cli([AGENT, "sessions", "close", "--session-id", id]);
    }
  });
}

test("TE C1 — two queued copies of one id + a different id, one batch behind a busy turn: the id is sent once", async () => {
  await copiesBehindBusyTurn(2);
});

test("TE C1b — three queued copies of one id + a different id, one batch behind a busy turn: sent once", async () => {
  await copiesBehindBusyTurn(3);
});
