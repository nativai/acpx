// brick 21b73df0 — a person's Stop while a second message is steered into the running turn.
//
// Field shape (voice rig, 2026-11-12): M1 runs a long tool call; M2 (a different id) is steered in; Stop. The stream
// then read `accepted(M2) · cancelled(M2) · session/prompt(M2) · session/cancel`, which looked as if acpx had sent a
// message it had already settled cancelled. A wire tap on the real adapter showed the opposite: M2's `session/prompt`
// went out milliseconds after its `accepted`, seconds BEFORE the cancel, and acpx never sent anything afterwards. The
// work after the Stop was the Claude adapter's (it parks M2's message in the SDK input and its cancel never withdrew
// it). acpx's own defect was the RECORD: ACP frames wait in memory (`pendingMessages`) while a delivery event goes to
// the file at once, so the stream's line order was not wire order.
//
// Rows:
//   - "stream order" — RED on 61e7e1d5 / b9c4a3d4: the steer's `session/prompt` precedes its terminal and the cancel.
//   - "guard" — green on base by design: pins the guarantee the field reading suspected (no `session/prompt` reaches
//     the adapter after the cancel, ONE `cancelled` terminal, no new turn), on the adapter's own operation log.
//   - "negative" — the same steer WITHOUT a cancel is delivered once and answered: the mock and the path cancel
//     nothing on their own.
//
// REAL PROCESSES. The mock parks a concurrent prompt the way claude-agent-acp does (`--park-concurrent-prompts`).
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
const WAIT_MS = 60_000;

type CliRunResult = { code: number | null; stdout: string; stderr: string };

type Rig = {
  homeDir: string;
  cwd: string;
  /** The mock adapter's own record of what reached it, in arrival order (`--operation-log`). */
  opsFile: string;
  cli: (args: string[]) => Promise<CliRunResult>;
};

function startProbeServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response
        .writeHead(200, {
          "anthropic-ratelimit-unified-5h-utilization": "0.1",
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

async function withRig(
  run: (rig: Rig) => Promise<void>,
  options: { withdrawParked?: boolean } = {},
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-steer-stop-"));
  const { server, url } = await startProbeServer();
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    // The adapter path must read as claude-agent-acp: that is what turns mid-turn steering on.
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const opsFile = path.join(homeDir, "adapter-ops.jsonl");
    const command = [
      "node",
      adapterPath,
      "--claude-agent-acp",
      "--supports-load-session",
      "--park-concurrent-prompts",
      ...(options.withdrawParked ? ["--withdraw-parked-on-cancel"] : []),
      "--operation-log",
      opsFile,
    ].join(" ");
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
    );
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "dflt"), { recursive: true });
    await fs.writeFile(
      path.join(subsDir, "dflt", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "token-dflt" } }),
    );
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify({
        version: 3,
        default: "dflt",
        profiles: [
          {
            id: "dflt",
            label: "dflt",
            authMode: "subscription",
            adapter: "claude",
            account: "dflt-account",
            credentialSource: path.join(subsDir, "dflt"),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const base = { homeDir, cwd, probeUrl: url };
    await run({ homeDir, cwd, opsFile, cli: async (args) => await runCli(base, args) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempHome(homeDir);
  }
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

function streamFile(rig: Rig, id: string): string {
  return path.join(rig.homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}.stream.ndjson`);
}

/** Each delivery event of `messageId`, in stream order, as `phase/stopReason`. */
function phasesOf(stream: string, messageId: string): string[] {
  return frames(stream).flatMap((frame) => {
    const params = frame.params as
      | { messageId?: unknown; phase?: unknown; stopReason?: unknown }
      | undefined;
    if (frame.method !== "acpx/delivery" || params?.messageId !== messageId) {
      return [];
    }
    return [`${String(params.phase)}/${String(params.stopReason)}`];
  });
}

/** The `error.detailCode` of `messageId`'s `cancelled` terminal (undefined if there is none). */
function cancelledDetailCode(stream: string, messageId: string): string | undefined {
  for (const frame of frames(stream)) {
    const params = frame.params as
      | { messageId?: unknown; phase?: unknown; error?: { detailCode?: unknown } }
      | undefined;
    if (
      frame.method === "acpx/delivery" &&
      params?.messageId === messageId &&
      params.phase === "cancelled"
    ) {
      return String(params.error?.detailCode ?? "");
    }
  }
  return undefined;
}

function turnActiveCount(stream: string): number {
  return frames(stream).filter(
    (frame) =>
      frame.method === "acpx/turn" &&
      (frame.params as { phase?: unknown } | undefined)?.phase === "active",
  ).length;
}

type Steered = {
  id: string;
  m1: string;
  m2: string;
  nonce: string;
  stream: string;
  ops: Array<Record<string, unknown>>;
};

// M1 runs; M2 (a different id, `--no-wait`) is steered in and reaches the adapter (parked there); then, when asked,
// the person's Stop (`acpx claude cancel`).
async function steerThenMaybeStop(
  rig: Rig,
  options: { stop: boolean; m1Text: string },
): Promise<Steered> {
  const created = await rig.cli(["--format", "json", "claude", "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId);
  const m1 = randomUUID();
  const m2 = randomUUID();
  const nonce = `steer-${randomUUID()}`;
  try {
    const first = rig.cli([
      "--approve-all",
      "claude",
      "prompt",
      "--session-id",
      id,
      "--message-id",
      m1,
      options.m1Text,
    ]);
    await waitFor(
      async () =>
        phasesOf(await readText(streamFile(rig, id)), m1).some((phase) =>
          phase.startsWith("accepted/"),
        ),
      "M1 accepted (mid-turn)",
    );
    const steer = await rig.cli([
      "--approve-all",
      "claude",
      "prompt",
      "--no-wait",
      "--session-id",
      id,
      "--message-id",
      m2,
      `echo ${nonce}`,
    ]);
    assert.equal(steer.code, 0, `${steer.stdout}\n${steer.stderr}`);
    // Precondition: M2 is in the adapter's hands (parked behind M1) — the field shape at the moment of the Stop.
    await waitFor(
      async () =>
        frames(await readText(rig.opsFile)).some(
          (op) => op.method === "session/prompt" && String(op.text).includes(nonce),
        ),
      "M2 received by the adapter",
    );
    if (options.stop) {
      const stopped = await rig.cli(["claude", "cancel", "--session-id", id]);
      assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    }
    await first;
    await waitFor(async () => {
      const turns = frames(await readText(streamFile(rig, id))).filter(
        (frame) => frame.method === "acpx/turn",
      );
      return (turns.at(-1)?.params as { phase?: unknown } | undefined)?.phase === "idle";
    }, "the turn to end");
    // Let anything a send or a new turn after the Stop would produce reach both records.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return {
      id,
      m1,
      m2,
      nonce,
      stream: await readText(streamFile(rig, id)),
      ops: frames(await readText(rig.opsFile)),
    };
  } finally {
    await rig.cli(["claude", "sessions", "close", "--session-id", id]);
  }
}

function indexWhere(
  list: Array<Record<string, unknown>>,
  match: (frame: Record<string, unknown>) => boolean,
): number {
  return list.findIndex(match);
}

function carries(frame: Record<string, unknown>, nonce: string): boolean {
  return JSON.stringify(frame.params ?? null).includes(nonce);
}

test("21b73df0 stream order — the steer's session/prompt precedes its cancelled terminal and the session/cancel", async () => {
  await withRig(async (rig) => {
    const run = await steerThenMaybeStop(rig, { stop: true, m1Text: "sleep 20321" });
    const stream = frames(run.stream);
    const diag = `stream:\n${run.stream}`;
    const prompt = indexWhere(
      stream,
      (frame) => frame.method === "session/prompt" && carries(frame, run.nonce),
    );
    const cancel = indexWhere(stream, (frame) => frame.method === "session/cancel");
    const terminal = indexWhere(stream, (frame) => {
      const params = frame.params as { messageId?: unknown; phase?: unknown } | undefined;
      return (
        frame.method === "acpx/delivery" &&
        params?.messageId === run.m2 &&
        params.phase === "cancelled"
      );
    });
    assert.ok(prompt >= 0 && cancel >= 0 && terminal >= 0, `all three recorded\n${diag}`);
    // Wire truth, from the adapter's own log: M2 arrived before the cancel. The stream must say the same.
    const opPrompt = indexWhere(
      run.ops,
      (op) => op.method === "session/prompt" && String(op.text).includes(run.nonce),
    );
    const opCancel = indexWhere(run.ops, (op) => op.method === "session/cancel");
    assert.ok(
      opPrompt >= 0 && opPrompt < opCancel,
      `precondition: M2 on the wire before the cancel`,
    );
    assert.ok(
      prompt < terminal,
      `M2's session/prompt is recorded before its cancelled terminal\n${diag}`,
    );
    assert.ok(
      prompt < cancel,
      `M2's session/prompt is recorded before the session/cancel\n${diag}`,
    );
    assert.ok(cancel < terminal, `the cancel is recorded before the terminal it caused\n${diag}`);
  });
});

test("21b73df0 guard — after a Stop no session/prompt reaches the adapter, the steer settles cancelled once, no new turn", async () => {
  await withRig(async (rig) => {
    const run = await steerThenMaybeStop(rig, { stop: true, m1Text: "sleep 20333" });
    const diag = `ops:\n${JSON.stringify(run.ops)}\nstream:\n${run.stream}`;
    const opCancel = indexWhere(run.ops, (op) => op.method === "session/cancel");
    assert.ok(opCancel >= 0, `the cancel reached the adapter\n${diag}`);
    const promptsAfter = run.ops
      .slice(opCancel + 1)
      .filter((op) => op.method === "session/prompt").length;
    assert.equal(promptsAfter, 0, `no session/prompt after the cancel\n${diag}`);
    const m2Prompts = run.ops.filter(
      (op) => op.method === "session/prompt" && String(op.text).includes(run.nonce),
    ).length;
    assert.equal(m2Prompts, 1, `M2 sent exactly once\n${diag}`);
    const phases = phasesOf(run.stream, run.m2);
    const terminals = phases.filter((phase) => !phase.startsWith("accepted/"));
    assert.deepEqual(terminals, ["cancelled/cancelled"], `M2: one cancelled terminal\n${diag}`);
    assert.ok(
      phasesOf(run.stream, run.m1).includes("cancelled/cancelled"),
      `precondition: the Stop ended M1\n${diag}`,
    );
    assert.equal(turnActiveCount(run.stream), 1, `no turn after the Stop\n${diag}`);
  });
});

test("21b73df0 negative — the same steer without a Stop is delivered once and answered", async () => {
  await withRig(async (rig) => {
    const run = await steerThenMaybeStop(rig, { stop: false, m1Text: "sleep 3127" });
    const diag = `ops:\n${JSON.stringify(run.ops)}\nstream:\n${run.stream}`;
    assert.equal(
      run.ops.filter((op) => op.method === "session/cancel").length,
      0,
      `no cancel in this row\n${diag}`,
    );
    const m2Prompts = run.ops.filter(
      (op) => op.method === "session/prompt" && String(op.text).includes(run.nonce),
    ).length;
    assert.equal(m2Prompts, 1, `M2 sent exactly once\n${diag}`);
    assert.deepEqual(
      phasesOf(run.stream, run.m2).filter((phase) => !phase.startsWith("accepted/")),
      ["done/end_turn"],
      `M2 delivered\n${diag}`,
    );
    const answered = frames(run.stream).some(
      (frame) => frame.method === "session/update" && carries(frame, run.nonce),
    );
    assert.ok(answered, `the agent answered M2\n${diag}`);
  });
});

// Requirement 1 of the consolidation (21b73df0): a reader tells, per delivery id and from positive evidence only,
// "withdrawn before the agent began" from "the agent had it and was stopped".
test("21b73df0 withdrawn mark — a steer the adapter confirms withdrawn ends CANCELLED_WITHDRAWN, the stopped turn CANCELLED_MID_TURN", async () => {
  await withRig(
    async (rig) => {
      const run = await steerThenMaybeStop(rig, { stop: true, m1Text: "sleep 20341" });
      const diag = `stream:\n${run.stream}`;
      assert.equal(cancelledDetailCode(run.stream, run.m2), "CANCELLED_WITHDRAWN", diag);
      assert.equal(cancelledDetailCode(run.stream, run.m1), "CANCELLED_MID_TURN", diag);
    },
    { withdrawParked: true },
  );
});

test("21b73df0 withdrawn mark — negative: without the adapter's mark the steer is CANCELLED_MID_TURN, never inferred withdrawn", async () => {
  await withRig(async (rig) => {
    const run = await steerThenMaybeStop(rig, { stop: true, m1Text: "sleep 20353" });
    const diag = `stream:\n${run.stream}`;
    assert.equal(cancelledDetailCode(run.stream, run.m2), "CANCELLED_MID_TURN", diag);
    assert.equal(cancelledDetailCode(run.stream, run.m1), "CANCELLED_MID_TURN", diag);
  });
});
