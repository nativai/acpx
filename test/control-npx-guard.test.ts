import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { splitCommandLine } from "../src/acp/client-process.js";
import { AcpClient } from "../src/acp/client.js";
import { assertControlNpxLaunchAllowed } from "../src/acp/control-npx-guard.js";
import {
  AGENT_REGISTRY,
  BUILT_IN_AGENT_PACKAGES,
  listAgentLaunchForms,
  resolveBuiltInAgentLaunch,
  resolvePiAcpCommand,
} from "../src/agent-registry.js";

test("shipped built-ins do not require unguarded alternative package executors", () => {
  for (const agent of Object.keys(AGENT_REGISTRY)) {
    for (const command of listAgentLaunchForms(agent)) {
      assert.doesNotMatch(command, /\b(?:pnpm|yarn)\b.*\bdlx\b|\bbunx\b/);
    }
  }
});

function controlRole(t: TestContext): void {
  const previous = process.env.NV_DEV_SERVER_ROLE;
  process.env.NV_DEV_SERVER_ROLE = "control";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.NV_DEV_SERVER_ROLE;
    } else {
      process.env.NV_DEV_SERVER_ROLE = previous;
    }
  });
}

function launchPlan(t: TestContext, cwd: string, agentCommand: string) {
  const client = new AcpClient({ cwd, agentCommand, permissionMode: "approve-all" });
  const planner = client as unknown as {
    resolveAgentLaunchPlan(): Promise<{ spawnCommand: string; args: string[] }>;
    applyProfileEnv(env: NodeJS.ProcessEnv): Promise<void>;
    applyHarnessConfigDirEnv(env: NodeJS.ProcessEnv): Promise<void>;
  };
  // Exercise real launch resolution without credentials, primers, or a spawn.
  t.mock.method(planner, "applyProfileEnv", async () => {});
  t.mock.method(planner, "applyHarnessConfigDirEnv", async () => {});
  return planner.resolveAgentLaunchPlan();
}

test("Pi missing-fork fallback is refused from a shared control cwd", async (t) => {
  controlRole(t);
  const fallback = resolvePiAcpCommand({}, () => false);
  assert.equal(splitCommandLine(fallback).command, "npx");
  assert.equal(resolveBuiltInAgentLaunch(fallback), undefined);
  await assert.rejects(
    launchPlan(t, "/workspace/project", fallback),
    /Control pod refused an npx\/npm-exec adapter launch/,
  );
});

test("installed Pi, Claude, and Codex built-ins remain launchable from a shared control cwd", async (t) => {
  controlRole(t);
  const commands = [
    [resolvePiAcpCommand({}, () => true), "/opt/pi-acp/dist/index.js"],
    [AGENT_REGISTRY.codex, "/opt/codex-acp/dist/index.js"],
    [AGENT_REGISTRY.claude, "/opt/claude-agent-acp/dist/index.js"],
  ] as const;
  for (const [command, adapter] of commands) {
    assert.equal(command, `node ${adapter}`);
    assert.equal(resolveBuiltInAgentLaunch(command), undefined);
    const plan = await launchPlan(t, "/workspace/project", command);
    assert.equal(plan.spawnCommand, "node");
    assert.deepEqual(plan.args, [adapter]);
  }
});

test("a package-exec produced after initial command parsing is refused before spawn", async (t) => {
  controlRole(t);
  const command = "l3-resolved-adapter";
  const packages = BUILT_IN_AGENT_PACKAGES as Record<
    string,
    { packageName: string; packageRange: string; preferredBinName: string; fallbackCommand: string }
  >;
  assert.equal(packages.l3GuardFixture, undefined);
  packages.l3GuardFixture = {
    packageName: "@acpx-tests/never-install-this",
    packageRange: "1.0.0",
    preferredBinName: command,
    fallbackCommand: command,
  };
  t.after(() => {
    delete packages.l3GuardFixture;
  });
  assert.doesNotThrow(() =>
    assertControlNpxLaunchAllowed("/workspace/project", splitCommandLine(command)),
  );
  const resolved = resolveBuiltInAgentLaunch(command);
  assert.equal(resolved?.source, "package-exec", "fixture must traverse the real npm resolver");
  const privatePlan = await launchPlan(t, "/data/runtime", command);
  assert.equal(privatePlan.spawnCommand, resolved?.command);
  assert.deepEqual(privatePlan.args, resolved?.args);
  await assert.rejects(
    launchPlan(t, "/workspace/project", command),
    /Control pod refused an npx\/npm-exec adapter launch/,
  );
});

test("control refuses standard npx/package-exec forms from shared cwd; other cases remain", () => {
  const control = { NV_DEV_SERVER_ROLE: "control" };
  const commands = [
    { command: "npx", args: ["pi-acp@^0.0.33"] },
    { command: "/usr/local/bin/npx", args: ["-y", "adapter"] },
    { command: "npx.cmd", args: ["adapter"] },
    { command: "npm", args: ["exec", "--", "adapter"] },
    { command: "node", args: ["/usr/local/lib/node_modules/npm/bin/npx-cli.js", "adapter"] },
    {
      command: "node",
      args: ["/usr/local/lib/node_modules/npm/bin/npm-cli.js", "exec", "--", "adapter"],
    },
  ];
  for (const command of commands) {
    for (const cwd of ["/workspace", "/workspace/project", "/wisdom/Project"]) {
      assert.throws(
        () => assertControlNpxLaunchAllowed(cwd, command, control),
        /Install the adapter into the control runtime \(\/opt\), or run it in a workbench/,
      );
      assert.doesNotThrow(() =>
        assertControlNpxLaunchAllowed(cwd, command, { NV_DEV_SERVER_ROLE: "workbench" }),
      );
    }
    for (const cwd of ["/data/runtime", "/workspace-other", "/wisdom-other"]) {
      assert.doesNotThrow(() => assertControlNpxLaunchAllowed(cwd, command, control));
    }
  }
  assert.doesNotThrow(() =>
    assertControlNpxLaunchAllowed(
      "/workspace",
      { command: "node", args: ["/opt/pi-acp/dist/index.js"] },
      control,
    ),
  );
});

test("AcpClient refuses before executing a planted npx; symlink cwd cannot evade it", async (t) => {
  mkdirSync("/workspace/projects/temp", { recursive: true });
  const shared = mkdtempSync("/workspace/projects/temp/acpx-npx-guard-");
  const privateRoot = mkdtempSync(join(tmpdir(), "acpx-npx-guard-"));
  t.after(() => {
    rmSync(shared, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  });
  const witness = join(privateRoot, "EXECUTED"),
    fake = join(privateRoot, "npx");
  writeFileSync(fake, `#!/bin/sh\ntouch '${witness}'\nexit 42\n`);
  chmodSync(fake, 0o755);
  assert.equal(spawnSync(fake).status, 42);
  assert.ok(existsSync(witness));
  rmSync(witness);
  const alias = join(privateRoot, "alias");
  symlinkSync(shared, alias);
  const previous = process.env.NV_DEV_SERVER_ROLE;
  process.env.NV_DEV_SERVER_ROLE = "control";
  try {
    for (const cwd of [shared, alias]) {
      const client = new AcpClient({
        cwd,
        agentCommand: `${fake} pi-acp@^0.0.33`,
        permissionMode: "approve-all",
      });
      await assert.rejects(client.start(), /Control pod refused an npx\/npm-exec adapter launch/);
      assert.equal(existsSync(witness), false, "refusal must precede any npx execution");
    }
  } finally {
    if (previous === undefined) {
      delete process.env.NV_DEV_SERVER_ROLE;
    } else {
      process.env.NV_DEV_SERVER_ROLE = previous;
    }
  }
});
