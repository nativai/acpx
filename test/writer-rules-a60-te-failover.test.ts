// A-60 / C3.5 — the independent TE's failover row (brick f67e0ff1): the implementer's risk 1, "a
// retry/failover path that re-hydrates in the same process". A real queue owner's turn streams a
// partial (the live checkpoint publishes it inline), then the subscription refuses it with its limit;
// reactive failover re-runs the turn on the other subscription IN THE SAME OWNER PROCESS, from a
// record it reads again. After that turn the history must hold the served reply exactly once, as the
// last entry, the partial at most once and before it, and nothing left inline.
//
// The rig is `owner-switch-keeps-background-tasks.test.ts`'s (a real CLI, a real owner, the mock
// launched from a `claude-agent-acp/` path; a usage-probe server; two subscriptions).
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";
import { removeTempHome } from "./temp-home.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type CliRunResult = { code: number | null; stdout: string; stderr: string };
type RigBase = { homeDir: string; cwd: string; subsDir: string; probeUrl: string };
type Rig = RigBase & { cli: (args: string[], env?: NodeJS.ProcessEnv) => Promise<CliRunResult> };

function startProbeServer(): Promise<{ server: Server; url: string }> {
  const fiveHour: Record<string, string> = { "token-dflt": "0.5", "token-target": "0.1" };
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
  rig: RigBase,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
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
    Object.assign(env, extra);
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

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a60-te-failover-"));
  const { server, url } = await startProbeServer();
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const command = `node ${adapterPath} --claude-agent-acp --supports-load-session`;
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
    const base: RigBase = { homeDir, cwd, subsDir, probeUrl: url };
    await body({ ...base, cli: async (args, env) => await runCli(base, args, env) });
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

type RecordView = {
  acp_session_id: string;
  messages?: unknown[];
  acpx?: { session_options?: { profile?: string } };
};

async function readRecord(rig: Rig, id: string): Promise<RecordView> {
  return JSON.parse(await fs.readFile(sessionFile(rig, id, ".json"), "utf8")) as RecordView;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test(
  "TE.5 failover after a streamed partial: the re-run turn's reply is in history once and last, the partial at most once and before it, nothing left inline",
  { timeout: 300_000 },
  async () => {
    await withRig(async (rig) => {
      const created = await rig.cli(["--format", "json", "claude", "sessions", "new"]);
      assert.equal(created.code, 0, created.stderr);
      const id = String(
        (JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId,
      );
      try {
        const off = await rig.cli([
          "claude",
          "set",
          "auto-subscription",
          "off",
          "--session-id",
          id,
        ]);
        assert.equal(off.code, 0, off.stderr);
        const warm = await rig.cli([
          "--approve-all",
          "claude",
          "prompt",
          "--session-id",
          id,
          "echo WARM-TURN",
        ]);
        assert.equal(warm.code, 0, warm.stderr);
        // The switch ports the Claude transcript; the mock writes none, so the row does.
        const record = await readRecord(rig, id);
        const transcript = transcriptJsonlPath(
          path.join(rig.subsDir, "dflt"),
          rig.cwd,
          record.acp_session_id,
        );
        await fs.mkdir(path.dirname(transcript), { recursive: true });
        await fs.writeFile(transcript, '{"type":"assistant","text":"context"}\n');

        const served = await rig.cli(
          [
            "--approve-all",
            "claude",
            "prompt",
            "--session-id",
            id,
            "stream-then-limit-on /dflt FO-PARTIAL-MARK",
          ],
          { A60_RECORD_FILE: sessionFile(rig, id, ".json") },
        );
        const ownerLog = await readText(sessionFile(rig, id, ".owner.log"));
        assert.equal(served.code, 0, `${served.stdout}\n${served.stderr}\n${ownerLog}`);
        assert.match(served.stdout, /SERVED-AFTER-FAILOVER/u, "the retried turn was served");
        assert.equal((await readRecord(rig, id)).acpx?.session_options?.profile, "target");

        const log = await readText(sessionFile(rig, id, ".messages.ndjson"));
        for (const line of log.split("\n").filter((entry) => entry.length > 0)) {
          JSON.parse(line);
        }
        const read = await rig.cli([
          "--format",
          "json",
          "claude",
          "sessions",
          "read",
          "--session-id",
          id,
        ]);
        assert.equal(read.code, 0, read.stderr);
        assert.doesNotMatch(read.stderr, /malformed/u);
        // The assistant entries in history order (the prompt text carries the mark too).
        const entries = (
          JSON.parse(read.stdout.trim()) as {
            entries: Array<{ role: string; textPreview: string }>;
          }
        ).entries;
        const history = entries
          .filter((entry) => entry.role === "assistant")
          .map((entry) => entry.textPreview)
          .join("\n|ENTRY|\n");
        assert.equal(count(history, "SERVED-AFTER-FAILOVER"), 1, `reply once:\n${history}`);
        assert.ok(count(history, "FO-PARTIAL-MARK") <= 1, `the partial at most once:\n${history}`);
        assert.ok(
          history.lastIndexOf("SERVED-AFTER-FAILOVER") > history.lastIndexOf("FO-PARTIAL-MARK"),
          `the served reply is the last thing in history:\n${history}\nlog:\n${log}`,
        );
        const inline = JSON.stringify((await readRecord(rig, id)).messages ?? []);
        assert.equal(count(inline, "FO-PARTIAL-MARK"), 0, `nothing stale left inline: ${inline}`);
      } finally {
        await rig.cli(["claude", "sessions", "close", id]);
      }
    });
  },
);
