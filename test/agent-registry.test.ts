import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  AGENT_REGISTRY,
  BUILT_IN_AGENT_PACKAGES,
  DEFAULT_AGENT_NAME,
  listBuiltInAgents,
  resolveBuiltInAgentLaunch,
  resolveInstalledBuiltInAgentLaunch,
  resolveAgentCommand,
  resolvePiAcpCommand,
  PI_ACP_FORK_PATH,
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

test("AGENT_REGISTRY.codex falls back to /opt path when ACPX_CODEX_ACP_COMMAND is empty string", async () => {
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
  assert.equal(result, "node /opt/codex-acp/dist/index.js");
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
    "claude-pty",
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

test("claude and codex are not built-in packages so the /opt fork commands spawn verbatim", () => {
  // The fork overrides run the container-built bridges directly. Keeping claude and
  // codex out of BUILT_IN_AGENT_PACKAGES is what stops resolveBuiltInAgentLaunch from
  // shadowing them with an installed / npx-exec'd published package — see src/agent-registry.ts.
  assert.equal(AGENT_REGISTRY.claude, "node /opt/claude-agent-acp/dist/index.js");
  assert.equal(AGENT_REGISTRY.codex, "node /opt/codex-acp/dist/index.js");
  assert.equal(Object.keys(BUILT_IN_AGENT_PACKAGES).includes("claude"), false);
  assert.equal(Object.keys(BUILT_IN_AGENT_PACKAGES).includes("codex"), false);
  assert.equal(resolveBuiltInAgentLaunch(AGENT_REGISTRY.claude), undefined);
  assert.equal(resolveBuiltInAgentLaunch(AGENT_REGISTRY.codex), undefined);
});

test("pi built-in is the nativai fork when the box has it, the pinned upstream package otherwise", () => {
  // ⚠️ THIS ASSERTION IS DELIBERATELY TWO-VALUED, AND THE PREVIOUS ONE-VALUED
  // FORM WAS A TRAP. It read `assert.equal(AGENT_REGISTRY.pi, "npx pi-acp@^0.0.33")`,
  // which passes on a box with no `/opt/pi-acp` and fails on every box where the
  // fork IS installed — i.e. it would have gone red on exactly the boxes where
  // the product is working as intended, as soon as the bootstrap rolled out.
  //
  // ⚠️ `^0.0.33` is an EXACT pin under npm semver (a caret on 0.0.x allows only
  // that patch), so that literal IS the upstream version acpx launches when it
  // falls back. Which of the two actually ran is settled by the SPAWN LINE, never
  // by this string — program rows `G1-PIN-01` / `G4-PI-01`.
  const forkInstalled = existsSync("/opt/pi-acp/dist/index.js");
  assert.equal(
    AGENT_REGISTRY.pi,
    forkInstalled ? "node /opt/pi-acp/dist/index.js" : "npx pi-acp@^0.0.33",
    `/opt/pi-acp/dist/index.js ${forkInstalled ? "exists" : "does not exist"} on this box`,
  );
});

test("pi command resolution: env seam wins, then the fork, then the pinned upstream", () => {
  // The env seam is the one claude/codex/claude-pty already have; I2 recorded its
  // absence for pi as a gap (no `ACPX_PI_ACP_COMMAND`, so the only overrides were
  // editing this file or acpx config).
  const present = () => true;
  const absent = () => false;

  assert.equal(
    resolvePiAcpCommand({ ACPX_PI_ACP_COMMAND: "node /tmp/custom-pi-acp.js" }, present),
    "node /tmp/custom-pi-acp.js",
    "the env seam must win even when the fork is installed",
  );
  assert.equal(resolvePiAcpCommand({}, present), `node ${PI_ACP_FORK_PATH}`);
  assert.equal(resolvePiAcpCommand({}, absent), "npx pi-acp@^0.0.33");
  assert.equal(
    resolvePiAcpCommand({ ACPX_PI_ACP_COMMAND: "   " }, absent),
    "npx pi-acp@^0.0.33",
    "a blank override is not an override",
  );
});

test("resolveInstalledBuiltInAgentLaunch returns undefined now that no built-in packages remain", () => {
  assert.equal(resolveInstalledBuiltInAgentLaunch("custom-acp-server --stdio"), undefined);
});
