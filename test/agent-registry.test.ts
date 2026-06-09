import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_REGISTRY,
  BUILT_IN_AGENT_PACKAGES,
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveBuiltInAgentLaunch,
  resolveInstalledBuiltInAgentLaunch,
  resolvePackageExecBuiltInAgentLaunch,
  resolveAgentCommand,
} from "../src/agent-registry.js";

test("resolveAgentCommand maps known agents to commands", () => {
  for (const [name, command] of Object.entries(AGENT_REGISTRY)) {
    assert.equal(resolveAgentCommand(name), command);
  }
});

test("AGENT_REGISTRY.claude uses ACPX_CLAUDE_ACP_COMMAND env override when set", async () => {
  const { execFileSync } = await import("node:child_process");
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { AGENT_REGISTRY } from "./dist-test/src/agent-registry.js"; process.stdout.write(AGENT_REGISTRY.claude);`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ACPX_CLAUDE_ACP_COMMAND: "my-custom-bridge --acp" },
      encoding: "utf8",
    },
  );
  assert.equal(result, "my-custom-bridge --acp");
});

test("AGENT_REGISTRY.claude falls back to /opt path when ACPX_CLAUDE_ACP_COMMAND is not set", () => {
  // In the test environment ACPX_CLAUDE_ACP_COMMAND is not set;
  // this verifies the registry was loaded with the fallback.
  const envOverride = process.env.ACPX_CLAUDE_ACP_COMMAND;
  const expected = envOverride || "node /opt/claude-agent-acp/dist/index.js";
  assert.equal(AGENT_REGISTRY.claude, expected);
});

test("AGENT_REGISTRY.claude falls back to /opt path when ACPX_CLAUDE_ACP_COMMAND is empty string", async () => {
  const { execFileSync } = await import("node:child_process");
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { AGENT_REGISTRY } from "./dist-test/src/agent-registry.js"; process.stdout.write(AGENT_REGISTRY.claude);`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ACPX_CLAUDE_ACP_COMMAND: "" },
      encoding: "utf8",
    },
  );
  assert.equal(result, "node /opt/claude-agent-acp/dist/index.js");
});

test("AGENT_REGISTRY.codex uses ACPX_CODEX_ACP_COMMAND env override when set", async () => {
  const { execFileSync } = await import("node:child_process");
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { AGENT_REGISTRY, resolveBuiltInAgentLaunch } from "./dist-test/src/agent-registry.js"; process.stdout.write(JSON.stringify({ command: AGENT_REGISTRY.codex, launch: resolveBuiltInAgentLaunch(AGENT_REGISTRY.codex) ?? null }));`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ACPX_CODEX_ACP_COMMAND: "node /tmp/codex-acp-fork/dist/index.js" },
      encoding: "utf8",
    },
  );
  assert.deepEqual(JSON.parse(result), {
    command: "node /tmp/codex-acp-fork/dist/index.js",
    launch: null,
  });
});

test("AGENT_REGISTRY.codex falls back to npx package when ACPX_CODEX_ACP_COMMAND is empty string", async () => {
  const { execFileSync } = await import("node:child_process");
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { AGENT_REGISTRY } from "./dist-test/src/agent-registry.js"; process.stdout.write(AGENT_REGISTRY.codex);`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ACPX_CODEX_ACP_COMMAND: "" },
      encoding: "utf8",
    },
  );
  assert.equal(result, "npx -y @agentclientprotocol/codex-acp@^0.0.44");
});

test("resolveAgentCommand returns raw value for unknown agents", () => {
  assert.equal(resolveAgentCommand("custom-acp-server"), "custom-acp-server");
});

test("resolveAgentCommand maps factory droid aliases to the droid command", () => {
  assert.equal(resolveAgentCommand("factory-droid"), AGENT_REGISTRY.droid);
  assert.equal(resolveAgentCommand("factorydroid"), AGENT_REGISTRY.droid);
});

test("resolveAgentCommand prefers explicit alias overrides over built-in alias mapping", () => {
  assert.equal(
    resolveAgentCommand("factory-droid", {
      "factory-droid": "custom-factory-droid --acp",
      droid: "custom-droid --acp",
    }),
    "custom-factory-droid --acp",
  );
});

test("trae built-in uses the standard traecli executable", () => {
  assert.equal(AGENT_REGISTRY.trae, "traecli acp serve");
  assert.equal(resolveAgentCommand("trae"), "traecli acp serve");
});

test("kiro built-in uses kiro-cli-chat directly", () => {
  assert.equal(AGENT_REGISTRY.kiro, "kiro-cli-chat acp");
  assert.equal(resolveAgentCommand("kiro"), "kiro-cli-chat acp");
});

test("listBuiltInAgents preserves the required example prefix and alphabetical tail", () => {
  const agents = listBuiltInAgents();
  assert.deepEqual(agents, Object.keys(AGENT_REGISTRY));
  assert.deepEqual(agents.slice(0, 7), [
    "pi",
    "openclaw",
    "codex",
    "claude",
    "gemini",
    "cursor",
    "copilot",
  ]);
  assert.deepEqual(agents.slice(7), [
    "droid",
    "iflow",
    "kilocode",
    "kimi",
    "kiro",
    "opencode",
    "qoder",
    "qwen",
    "trae",
  ]);
});

test("default agent is codex", () => {
  assert.equal(DEFAULT_AGENT_NAME, "codex");
});

test("claude is not a built-in package so the /opt fork command spawns verbatim", () => {
  // The fork override runs the container-built bridge directly. Keeping claude out of
  // BUILT_IN_AGENT_PACKAGES is what stops resolveBuiltInAgentLaunch from shadowing it
  // with an installed / npx-exec'd published package — see src/agent-registry.ts.
  assert.equal(AGENT_REGISTRY.claude, "node /opt/claude-agent-acp/dist/index.js");
  assert.equal(Object.keys(BUILT_IN_AGENT_PACKAGES).includes("claude"), false);
  assert.equal(resolveBuiltInAgentLaunch(AGENT_REGISTRY.claude), undefined);
});

test("npm-backed built-ins use current adapter package ranges", () => {
  assert.equal(BUILT_IN_AGENT_PACKAGES.codex.packageRange, "^0.0.44");
  assert.equal(AGENT_REGISTRY.codex, "npx -y @agentclientprotocol/codex-acp@^0.0.44");
  assert.equal(AGENT_REGISTRY.pi, "npx pi-acp@^0.0.26");
});

test("resolveInstalledBuiltInAgentLaunch uses a locally installed adapter when available", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-agent-registry-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const packageRoot = path.join(tempDir, "node_modules", "@agentclientprotocol", "codex-acp");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: BUILT_IN_AGENT_PACKAGES.codex.packageName,
      version: "0.0.44",
      bin: {
        "codex-acp": "bin/codex-acp.js",
      },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(packageRoot, "bin", "codex-acp.js"), "#!/usr/bin/env node\n");

  const launch = resolveInstalledBuiltInAgentLaunch(AGENT_REGISTRY.codex, {
    resolvePackageRoot: () => packageRoot,
  });

  assert.deepEqual(launch, {
    source: "installed",
    command: process.execPath,
    args: [path.join(packageRoot, "bin", "codex-acp.js")],
    packageName: BUILT_IN_AGENT_PACKAGES.codex.packageName,
    packageRange: BUILT_IN_AGENT_PACKAGES.codex.packageRange,
    packageVersion: "0.0.44",
    binPath: path.join(packageRoot, "bin", "codex-acp.js"),
  });
});

test("resolveInstalledBuiltInAgentLaunch ignores non-built-in commands", () => {
  assert.equal(resolveInstalledBuiltInAgentLaunch("custom-acp-server --stdio"), undefined);
});

test("resolvePackageExecBuiltInAgentLaunch bridges built-ins through the current Node npm CLI", () => {
  const npmCliPath = path.join(os.tmpdir(), "acpx-test-npm-cli.js");
  const launch = resolvePackageExecBuiltInAgentLaunch(AGENT_REGISTRY.codex, {
    execPath: "/tmp/node",
    existsSync: (candidate) => candidate === npmCliPath,
    resolveNpmCliPath: () => npmCliPath,
  });

  assert.deepEqual(launch, {
    source: "package-exec",
    command: "/tmp/node",
    args: [
      npmCliPath,
      "exec",
      "--yes",
      `--package=${BUILT_IN_AGENT_PACKAGES.codex.packageName}@${BUILT_IN_AGENT_PACKAGES.codex.packageRange}`,
      "--",
      BUILT_IN_AGENT_PACKAGES.codex.preferredBinName,
    ],
    packageName: BUILT_IN_AGENT_PACKAGES.codex.packageName,
    packageRange: BUILT_IN_AGENT_PACKAGES.codex.packageRange,
    npmCliPath,
  });
});
