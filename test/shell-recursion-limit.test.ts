import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient, buildAgentSpawnOptions } from "../src/acp/client.js";
import { AGENT_FUNCNEST_ENV } from "../src/acp/shell-recursion-limit.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";
import { removeTempHome } from "./temp-home.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

// brick 6e5b34a8 (RCA brick://21d4a83d §1d): acpx defaults FUNCNEST=64 into every agent environment so a
// self-recursive shell function stops at depth 64 instead of forking until the pod is OOM-killed.
// The commands are the real adapter commands of the live store, plus a raw escape-hatch one.

const REAL_COMMANDS = {
  claude: "node /opt/claude-agent-acp/dist/index.js",
  codex: "node /opt/codex-acp/dist/index.js",
  pi: "node /opt/pi-acp/dist/index.js",
  raw: "node ./some-raw-agent.js",
};

function withParentEnv<T>(value: string | undefined, run: () => T): T {
  const saved = process.env[AGENT_FUNCNEST_ENV];
  if (value === undefined) {
    delete process.env[AGENT_FUNCNEST_ENV];
  } else {
    process.env[AGENT_FUNCNEST_ENV] = value;
  }
  try {
    return run();
  } finally {
    if (saved === undefined) {
      delete process.env[AGENT_FUNCNEST_ENV];
    } else {
      process.env[AGENT_FUNCNEST_ENV] = saved;
    }
  }
}

function adapterEnv(command: string): NodeJS.ProcessEnv {
  return buildAgentSpawnOptions(process.cwd(), undefined, undefined, {}, command).env ?? {};
}

// Bounded recursion probe: the function counts its own depth in a file-free way (stdout) and gives up
// at 200, so even an env WITHOUT the limit terminates. Returns the deepest level reached.
const RECURSE = `d=0; f(){ d=$((d+1)); echo "$d"; [ "$d" -ge 200 ] && return; f; }; f`;

function deepestLevel(env: NodeJS.ProcessEnv): { depth: number; stderr: string } {
  const run = spawnSync("bash", ["-c", RECURSE], { env, encoding: "utf8" });
  const levels = run.stdout.split("\n").filter((line) => line.length > 0);
  return { depth: Number(levels[levels.length - 1]), stderr: run.stderr };
}

test("FUNCNEST=64 is set on every harness's adapter env when the parent has none", () => {
  for (const [harness, command] of Object.entries(REAL_COMMANDS)) {
    const env = withParentEnv(undefined, () => adapterEnv(command));
    assert.equal(env[AGENT_FUNCNEST_ENV], "64", harness);
  }
});

test("an explicit FUNCNEST survives: the operator's value (including 0 = no limit) wins", () => {
  for (const explicit of ["128", "0"]) {
    const env = withParentEnv(explicit, () => adapterEnv(REAL_COMMANDS.claude));
    assert.equal(env[AGENT_FUNCNEST_ENV], explicit);
  }
});

test("control: the parent process env is untouched by building the spawn env", () => {
  withParentEnv(undefined, () => {
    adapterEnv(REAL_COMMANDS.claude);
    assert.equal(process.env[AGENT_FUNCNEST_ENV], undefined);
  });
});

test("ACP terminal commands get the same default; a request-named value wins", () => {
  const inherited = withParentEnv(
    undefined,
    () => buildTerminalSpawnOptions("true", os.tmpdir(), undefined).env ?? {},
  );
  assert.equal(inherited[AGENT_FUNCNEST_ENV], "64");
  const asked = withParentEnv(
    undefined,
    () =>
      buildTerminalSpawnOptions("true", os.tmpdir(), [{ name: AGENT_FUNCNEST_ENV, value: "8" }])
        .env ?? {},
  );
  assert.equal(asked[AGENT_FUNCNEST_ENV], "8");
});

test("behavioural: a bash started with the adapter env stops a recursive function at depth 64", () => {
  const env = withParentEnv(undefined, () => adapterEnv(REAL_COMMANDS.claude));
  const { depth, stderr } = deepestLevel(env);
  assert.equal(depth, 64);
  assert.match(stderr, /maximum function nesting level exceeded/);
});

// Negative case: the same probe with the variable removed from that very env is NOT stopped at 64,
// so the assertion above is the limit's doing and not a property of the probe.
test("negative control: without FUNCNEST the same probe runs past 64 to its own bound", () => {
  const env = withParentEnv(undefined, () => adapterEnv(REAL_COMMANDS.claude));
  delete env[AGENT_FUNCNEST_ENV];
  const { depth } = deepestLevel(env);
  assert.equal(depth, 200);
});

// The production shape: a REAL child spawned through AcpClient (not just the env object), whose own
// environment is read back by the child itself. Only an explicit parent value may differ from 64.
async function dumpedFuncnest(parentValue: string | undefined): Promise<string | undefined> {
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-funcnest-home-"));
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-funcnest-cwd-"));
  const envDumpPath = path.join(scratchDir, "env-dump.json");
  const previousHome = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  const client = new AcpClient({
    agentCommand:
      `node ${JSON.stringify(MOCK_AGENT_PATH)} --env-dump-file ${JSON.stringify(envDumpPath)} ` +
      `--env-dump-extra ${AGENT_FUNCNEST_ENV}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "rec-funcnest" },
  });
  try {
    return await withParentEnvAsync(parentValue, async () => {
      await client.start();
      await client.createSession();
      const dump = JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
      return dump[AGENT_FUNCNEST_ENV];
    });
  } finally {
    await client.close().catch(() => {});
    if (previousHome === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previousHome;
    }
    await removeTempHome(stateHome);
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

async function withParentEnvAsync<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env[AGENT_FUNCNEST_ENV];
  if (value === undefined) {
    delete process.env[AGENT_FUNCNEST_ENV];
  } else {
    process.env[AGENT_FUNCNEST_ENV] = value;
  }
  try {
    return await run();
  } finally {
    if (saved === undefined) {
      delete process.env[AGENT_FUNCNEST_ENV];
    } else {
      process.env[AGENT_FUNCNEST_ENV] = saved;
    }
  }
}

test("real spawn: the agent process itself observes FUNCNEST=64, or the operator's explicit value", async () => {
  assert.equal(await dumpedFuncnest(undefined), "64");
  assert.equal(await dumpedFuncnest("128"), "128");
});
