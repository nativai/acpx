// A one-shot `exec` binds its account exactly as `sessions new` does (brick eeca6037).
// Before the fix runOnce passed an unselected exec straight to the env builder, which
// leaves CLAUDE_CONFIG_DIR unset ("unbound stays raw"), so the adapter ran on the box's
// raw ~/.claude login — on labidio an organisation that refuses Claude Code — while a
// session created there ran on the registry default. A literal `--subscription auto`
// likewise reached the profile lookup unresolved ("profile \"auto\" not found").
// Asserted on what the spawned adapter actually received (the mock's env dump).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type Home = { homeDir: string; cwd: string; subsRoot: string; dumpPath: string };
type CliRunResult = { code: number | null; stdout: string; stderr: string };

async function withExecHome(
  registryDefault: string | undefined,
  run: (home: Home) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-exec-default-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subsRoot = path.join(homeDir, ".acpx", "subscriptions");
    const profiles = ["sub1", "sub2"].map((id) => ({
      id,
      label: id,
      authMode: "subscription",
      adapter: "claude",
      account: `acct-${id}`,
      credentialSource: path.join(subsRoot, id),
    }));
    for (const p of profiles) {
      await fs.mkdir(p.credentialSource, { recursive: true });
    }
    await fs.writeFile(
      path.join(subsRoot, "registry.json"),
      `${JSON.stringify({ version: 3, ...(registryDefault ? { default: registryDefault } : {}), profiles })}\n`,
      { mode: 0o600 },
    );
    const dumpPath = path.join(homeDir, "adapter-env.json");
    // The mock stands in at a real Claude adapter's path shape (production runs
    // `node …/claude-agent-acp/dist/index.js`): the default binding applies only to a
    // command acpx recognises as the Claude adapter, and a bare mock path is not one.
    // `.mjs`: top-level await outside a module package.
    const adapterEntry = path.join(homeDir, "claude-agent-acp", "dist", "index.mjs");
    await fs.mkdir(path.dirname(adapterEntry), { recursive: true });
    await fs.writeFile(
      adapterEntry,
      `await import(${JSON.stringify(pathToFileURL(MOCK_AGENT_PATH).href)});\n`,
    );
    const agent = `node ${JSON.stringify(adapterEntry)} --env-dump-file ${JSON.stringify(dumpPath)}`;
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command: agent } } }, null, 2)}\n`,
      "utf8",
    );
    await run({ homeDir, cwd, subsRoot, dumpPath });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// A parentless caller (an ssh shell): no inherited session identity or account.
async function runExec(home: Home, extraFlags: string[]): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home.homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SUBSCRIPTION",
      "ACPX_PROFILE",
      "CLAUDE_CONFIG_DIR",
      "ACPX_BRICK",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    const args = ["--approve-all", "--cwd", home.cwd, "--format", "quiet", ...extraFlags];
    const child = spawn(process.execPath, [CLI_PATH, ...args, "claude", "exec", "echo hello"], {
      env,
      cwd: home.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function adapterEnv(home: Home): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(home.dumpPath, "utf8")) as Record<string, string>;
}

test("exec without a selection runs on the registry default, not the raw ~/.claude login", async () => {
  await withExecHome("sub2", async (home) => {
    const result = await runExec(home, []);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /hello/);
    const env = await adapterEnv(home);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home.subsRoot, "sub2"));
    assert.equal(env.ACPX_SUBSCRIPTION, "sub2");
  });
});

test("exec --subscription <id> still runs on that id, not the default", async () => {
  await withExecHome("sub2", async (home) => {
    const result = await runExec(home, ["--subscription", "sub1"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await adapterEnv(home)).CLAUDE_CONFIG_DIR, path.join(home.subsRoot, "sub1"));
  });
});

test("exec --subscription auto resolves to a registered subscription (never the literal 'auto')", async () => {
  await withExecHome("sub2", async (home) => {
    const result = await runExec(home, ["--subscription", "auto"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /"auto" not found/);
    const dir = (await adapterEnv(home)).CLAUDE_CONFIG_DIR;
    assert.ok(
      [path.join(home.subsRoot, "sub1"), path.join(home.subsRoot, "sub2")].includes(dir ?? ""),
      `CLAUDE_CONFIG_DIR=${dir}`,
    );
  });
});

// Negative case: with no registry default there is nothing to bind, and the probe must
// see the adapter WITHOUT a CLAUDE_CONFIG_DIR — so the presence asserted above is acpx's
// binding, not something the harness or the dump put there.
test("exec with no registry default leaves CLAUDE_CONFIG_DIR unset (nothing to bind)", async () => {
  await withExecHome(undefined, async (home) => {
    const result = await runExec(home, []);
    assert.equal(result.code, 0, result.stderr);
    const env = await adapterEnv(home);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "CLAUDE_CONFIG_DIR"), false);
  });
});
