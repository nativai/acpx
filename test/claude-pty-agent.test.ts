import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isClaudePtyAcpCommand, isClaudePtyAgentCommand } from "../src/acp/agent-command.js";
import {
  applyProfileAuth,
  buildClaudeHomeSelectorMeta,
  INDEPENDENT_CLAUDE_HOME_MAP_ENV,
  INDEPENDENT_CLAUDE_HOME_META_KEY,
} from "../src/acp/auth-env.js";
import { AcpClient, buildAgentSpawnOptions } from "../src/acp/client.js";
import { AGENT_REGISTRY, resolveAgentCommand } from "../src/agent-registry.js";
import {
  buildClaudeHomeMap,
  getValidEffortsForProfile,
  isClaudeHomeProfileId,
  loadProfileRegistry,
} from "../src/config/profiles.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const DEFAULT_CLAUDE_PTY_COMMAND = "node /opt/claude-pty-acp/acp-server-transcript.mjs";
const SDK_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

// ---------------------------------------------------------------------------
// Slice 1 — `claude-pty` registry entry + ACPX_CLAUDE_PTY_ACP_COMMAND seam
// ---------------------------------------------------------------------------

test("AGENT_REGISTRY.claude-pty falls back to the /opt bridge path (Block-G seam pattern)", () => {
  const envOverride = process.env.ACPX_CLAUDE_PTY_ACP_COMMAND;
  const expected = envOverride || DEFAULT_CLAUDE_PTY_COMMAND;
  assert.equal(AGENT_REGISTRY["claude-pty"], expected);
  assert.equal(resolveAgentCommand("claude-pty"), expected);
});

test("AGENT_REGISTRY.claude-pty uses ACPX_CLAUDE_PTY_ACP_COMMAND env override when set", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { AGENT_REGISTRY, resolveBuiltInAgentLaunch } from "./dist-test/src/agent-registry.js"; process.stdout.write(JSON.stringify({ command: AGENT_REGISTRY["claude-pty"], launch: resolveBuiltInAgentLaunch(AGENT_REGISTRY["claude-pty"]) ?? null }));`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACPX_CLAUDE_PTY_ACP_COMMAND:
          "node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs",
      },
      encoding: "utf8",
    },
  );
  // launch must stay null: claude-pty has no BUILT_IN_AGENT_PACKAGES spec, so no
  // installed npm package can ever shadow the /opt (or override) command.
  assert.deepEqual(JSON.parse(result), {
    command: "node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs",
    launch: null,
  });
});

test("AGENT_REGISTRY.claude-pty falls back to /opt path when ACPX_CLAUDE_PTY_ACP_COMMAND is empty string", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { AGENT_REGISTRY } from "./dist-test/src/agent-registry.js"; process.stdout.write(AGENT_REGISTRY["claude-pty"]);`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ACPX_CLAUDE_PTY_ACP_COMMAND: "" },
      encoding: "utf8",
    },
  );
  assert.equal(result, DEFAULT_CLAUDE_PTY_COMMAND);
});

test("isClaudePtyAcpCommand detects the bridge across registry default, env seam, and config overrides", () => {
  assert.equal(isClaudePtyAgentCommand(DEFAULT_CLAUDE_PTY_COMMAND), true);
  assert.equal(
    isClaudePtyAgentCommand(
      "node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs",
    ),
    true,
  );
  // config.json agents entry shape: command + args resolve to a quoted string
  assert.equal(
    isClaudePtyAcpCommand("node", ["/opt/claude-pty-acp/acp-server-transcript.mjs"]),
    true,
  );
  // non-bridge agents must NOT match
  assert.equal(isClaudePtyAgentCommand(SDK_CLAUDE_COMMAND), false);
  assert.equal(isClaudePtyAgentCommand("node /opt/codex-acp/dist/index.js"), false);
  assert.equal(isClaudePtyAgentCommand(`node ${MOCK_AGENT_PATH}`), false);
});

// ---------------------------------------------------------------------------
// Slice 2 — profile loader: authMode "claude-home"
// ---------------------------------------------------------------------------

type ProfilesHomeContext = {
  lookupOptions: SubscriptionLookupOptions;
  homeDir: string;
};

async function withProfilesHome(
  registry: unknown,
  run: (ctx: ProfilesHomeContext) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-pty-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    const registryPath = path.join(subsDir, "registry.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));
    await run({ lookupOptions: { homeDir, registryPath }, homeDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

const HYBRID_REGISTRY = {
  default: "sub1",
  // v1 list stays readable by old binaries / --subscription
  subscriptions: [
    { id: "sub1", label: "Max 20x - 1" },
    { id: "sub2", label: "Max 20x - 2" },
  ],
  profiles: [
    { id: "sub1", label: "Max 20x - 1", harness: "claude", authMode: "subscription" },
    {
      id: "home1",
      label: "Max 20x - 1 (interactive)",
      harness: "claude",
      authMode: "claude-home",
      homePath: "/home/node/.acpx/homes/sub1",
      accountEmail: "one@example.com",
    },
    {
      id: "home2",
      label: "Max 20x - 2 (interactive)",
      harness: "claude",
      authMode: "claude-home",
      homePath: "/home/node/.acpx/homes/sub2",
    },
  ],
};

test("loader parses claude-home profiles (homePath, accountEmail) from a hybrid v1+v2 registry", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const registry = loadProfileRegistry(ctx.lookupOptions);
    assert.deepEqual(
      registry.profiles.map((p) => p.id),
      ["sub1", "home1", "home2"],
    );
    const home1 = registry.profiles.find((p) => p.id === "home1");
    assert.equal(home1?.authMode, "claude-home");
    assert.equal(home1?.homePath, "/home/node/.acpx/homes/sub1");
    assert.equal(home1?.accountEmail, "one@example.com");
    assert.equal(home1?.credentialSource, null);
    const home2 = registry.profiles.find((p) => p.id === "home2");
    assert.equal(home2?.homePath, "/home/node/.acpx/homes/sub2");
    assert.equal(home2?.accountEmail, undefined);
    // subscription profile untouched
    const sub1 = registry.profiles.find((p) => p.id === "sub1");
    assert.equal(sub1?.authMode, "subscription");
    assert.ok(sub1?.credentialSource?.endsWith(path.join(".acpx", "subscriptions", "sub1")));
  });
});

test("loader skips a claude-home profile without homePath (unusable, never guessed)", async () => {
  await withProfilesHome(
    {
      profiles: [
        { id: "broken", label: "no home", authMode: "claude-home" },
        { id: "ok", authMode: "claude-home", homePath: "/tmp/h" },
      ],
    },
    async (ctx) => {
      const registry = loadProfileRegistry(ctx.lookupOptions);
      assert.deepEqual(
        registry.profiles.map((p) => p.id),
        ["ok"],
      );
    },
  );
});

test("loader keeps UNKNOWN declared authModes inert (skipped, not coerced to subscription)", async () => {
  await withProfilesHome(
    {
      profiles: [
        { id: "future", authMode: "quantum-vault", credentialSource: "/tmp/x" },
        { id: "sub", authMode: "subscription" },
        { id: "legacy-shaped" }, // missing authMode still defaults to subscription
      ],
    },
    async (ctx) => {
      const registry = loadProfileRegistry(ctx.lookupOptions);
      assert.deepEqual(
        registry.profiles.map((p) => p.id),
        ["sub", "legacy-shaped"],
      );
      assert.equal(registry.profiles[1]?.authMode, "subscription");
    },
  );
});

test("v1-only registries are untouched by the claude-home addition (synthesised subscription profiles)", async () => {
  await withProfilesHome(
    { default: "sub2", subscriptions: [{ id: "sub1" }, { id: "sub2", label: "Two" }] },
    async (ctx) => {
      const registry = loadProfileRegistry(ctx.lookupOptions);
      assert.deepEqual(
        registry.profiles.map((p) => ({ id: p.id, authMode: p.authMode })),
        [
          { id: "sub1", authMode: "subscription" },
          { id: "sub2", authMode: "subscription" },
        ],
      );
      assert.equal(registry.default, "sub2");
      assert.deepEqual(buildClaudeHomeMap(registry), {});
    },
  );
});

test("buildClaudeHomeMap maps ALL claude-home profiles (id → homePath), nothing else", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const registry = loadProfileRegistry(ctx.lookupOptions);
    assert.deepEqual(buildClaudeHomeMap(registry), {
      home1: "/home/node/.acpx/homes/sub1",
      home2: "/home/node/.acpx/homes/sub2",
    });
  });
});

test("isClaudeHomeProfileId: true only for registered claude-home profiles", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    assert.equal(isClaudeHomeProfileId("home1", ctx.lookupOptions), true);
    assert.equal(isClaudeHomeProfileId(" home2 ", ctx.lookupOptions), true);
    assert.equal(isClaudeHomeProfileId("sub1", ctx.lookupOptions), false);
    assert.equal(isClaudeHomeProfileId("unknown", ctx.lookupOptions), false);
    assert.equal(isClaudeHomeProfileId(null, ctx.lookupOptions), false);
    assert.equal(isClaudeHomeProfileId(undefined, ctx.lookupOptions), false);
    assert.equal(isClaudeHomeProfileId("", ctx.lookupOptions), false);
  });
});

test("getValidEffortsForProfile: claude-home uses the interactive Claude effort ladder", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const registry = loadProfileRegistry(ctx.lookupOptions);
    const home1 = registry.profiles.find((p) => p.id === "home1");
    assert.ok(home1);
    assert.deepEqual(getValidEffortsForProfile(home1), ["low", "medium", "high", "xhigh", "max"]);
  });
});

test("buildClaudeHomeSelectorMeta emits the bridge's published _meta key for claude-home profiles only", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    assert.deepEqual(buildClaudeHomeSelectorMeta("home1", ctx.lookupOptions), {
      "independent-claude-acp/home": "home1",
    });
    assert.equal(INDEPENDENT_CLAUDE_HOME_META_KEY, "independent-claude-acp/home");
    assert.equal(buildClaudeHomeSelectorMeta("sub1", ctx.lookupOptions), undefined);
    assert.equal(buildClaudeHomeSelectorMeta("unknown", ctx.lookupOptions), undefined);
    assert.equal(buildClaudeHomeSelectorMeta(null, ctx.lookupOptions), undefined);
    assert.equal(buildClaudeHomeSelectorMeta("", ctx.lookupOptions), undefined);
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — applyProfileAuth: claude-home env injection + compatibility gate
// ---------------------------------------------------------------------------

test("applyProfileAuth (claude-home): injects the FULL home map, no CLAUDE_CONFIG_DIR/ACPX_SUBSCRIPTION", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: "/leaked/from/owner",
      ACPX_SUBSCRIPTION: "leaked-sub",
    };
    const shim = await applyProfileAuth(
      env,
      "home1",
      "session-1",
      null,
      ctx.lookupOptions,
      DEFAULT_CLAUDE_PTY_COMMAND,
    );
    assert.equal(shim, null);
    assert.deepEqual(JSON.parse(env[INDEPENDENT_CLAUDE_HOME_MAP_ENV] ?? "{}"), {
      home1: "/home/node/.acpx/homes/sub1",
      home2: "/home/node/.acpx/homes/sub2",
    });
    // subscription machinery must not leak onto a bridge spawn
    assert.equal("CLAUDE_CONFIG_DIR" in env, false);
    assert.equal("ACPX_SUBSCRIPTION" in env, false);
  });
});

test("applyProfileAuth rejects a claude-home profile on a NON-bridge agent (fail-fast, clear message)", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const env: NodeJS.ProcessEnv = {};
    await assert.rejects(
      applyProfileAuth(env, "home1", "session-1", null, ctx.lookupOptions, SDK_CLAUDE_COMMAND),
      /claude-home.*requires the claude-pty bridge agent/s,
    );
    assert.equal(INDEPENDENT_CLAUDE_HOME_MAP_ENV in env, false);
  });
});

test("applyProfileAuth rejects subscription and openrouter profiles on the bridge agent (setup-token gate)", async () => {
  await withProfilesHome(
    {
      ...HYBRID_REGISTRY,
      profiles: [
        ...HYBRID_REGISTRY.profiles,
        {
          id: "or-deepseek",
          authMode: "openrouter",
          model: "deepseek/deepseek-chat",
          openRouterApiKey: "test-key-never-logged",
        },
      ],
    },
    async (ctx) => {
      await assert.rejects(
        applyProfileAuth(
          {},
          "sub1",
          "session-1",
          null,
          ctx.lookupOptions,
          DEFAULT_CLAUDE_PTY_COMMAND,
        ),
        /cannot be used with the claude-pty bridge agent/,
      );
      await assert.rejects(
        applyProfileAuth(
          {},
          "or-deepseek",
          "session-1",
          null,
          ctx.lookupOptions,
          "node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs",
        ),
        /cannot be used with the claude-pty bridge agent/,
      );
    },
  );
});

test("applyProfileAuth: vanished profile + bridge agent fails the spawn (no silent box-default HOME run)", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    // Record still points at a profile that was deleted from the registry.
    await assert.rejects(
      applyProfileAuth(
        {},
        "deleted-home",
        "session-1",
        null,
        ctx.lookupOptions,
        DEFAULT_CLAUDE_PTY_COMMAND,
      ),
      /profile "deleted-home" not found in registry.*refusing to spawn under the box-default HOME/s,
    );
    // Non-bridge agents keep the legacy soft fallback (stderr note, null shim).
    await withCapturedStderrWrites(async (writes) => {
      const shim = await applyProfileAuth(
        {},
        "deleted-home",
        "session-1",
        null,
        ctx.lookupOptions,
        SDK_CLAUDE_COMMAND,
      );
      assert.equal(shim, null);
      assert.match(writes.join(""), /profile "deleted-home" not found in registry/);
    });
  });
});

test("applyProfileAuth: subscription profile on the SDK agent stays byte-identical (no gate misfire)", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const shim = await applyProfileAuth(
      env,
      "sub1",
      "session-1",
      null,
      ctx.lookupOptions,
      SDK_CLAUDE_COMMAND,
    );
    assert.equal(shim, null);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(subsDir, "sub1"));
    assert.equal(INDEPENDENT_CLAUDE_HOME_MAP_ENV in env, false);
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — buildAgentSpawnOptions: subscription resolution skipped for the bridge
// ---------------------------------------------------------------------------

test("buildAgentSpawnOptions (bridge, unselected): NO CLAUDE_CONFIG_DIR injection and NO default banner", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-claude-pty-cwd",
          undefined,
          { acpxRecordId: "rec" }, // no profile, no subscription selected
          ctx.lookupOptions,
          DEFAULT_CLAUDE_PTY_COMMAND,
        );
        assert.equal(Object.prototype.hasOwnProperty.call(options.env, "CLAUDE_CONFIG_DIR"), false);
        assert.equal(writes.join(""), "");
      });
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});

test("buildAgentSpawnOptions (bridge, explicit --subscription): fails fast with an actionable error", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    assert.throws(
      () =>
        buildAgentSpawnOptions(
          "/tmp/acpx-claude-pty-cwd",
          undefined,
          { acpxRecordId: "rec", subscriptionId: "sub1" },
          ctx.lookupOptions,
          DEFAULT_CLAUDE_PTY_COMMAND,
        ),
      /subscription "sub1" cannot be used with the claude-pty bridge agent/,
    );
  });
});

test("buildAgentSpawnOptions (non-bridge): subscription resolution unchanged when agentCommand is passed", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-claude-pty-cwd",
      undefined,
      { acpxRecordId: "rec", subscriptionId: "sub1" },
      ctx.lookupOptions,
      SDK_CLAUDE_COMMAND,
    );
    assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(subsDir, "sub1"));
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — client-level: map env + _meta selector on EVERY spawn (restart safety)
// ---------------------------------------------------------------------------

type SpawnEvidence = {
  envDump: Record<string, string>;
  newSessionMeta: Record<string, unknown> | undefined;
};

type OutboundCapture = { method?: string; params?: { _meta?: Record<string, unknown> } };

// Run the mock agent under a path that the claude-pty detection matches, so the
// client treats it as the bridge. Node resolves the symlink's realpath for module
// resolution, so the mock agent's SDK import keeps working.
async function withBridgeNamedMockAgent(
  run: (bridgeScriptPath: string, scratchDir: string) => Promise<void>,
): Promise<void> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-pty-client-"));
  try {
    const bridgeDir = path.join(scratchDir, "claude-pty-acp");
    await fs.mkdir(bridgeDir, { recursive: true });
    const bridgeScriptPath = path.join(bridgeDir, "acp-server-transcript.mjs");
    await fs.symlink(MOCK_AGENT_PATH, bridgeScriptPath);
    await run(bridgeScriptPath, scratchDir);
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

// Point os.homedir() (and thus the default profile-registry resolution inside
// the client spawn path, which takes no lookupOptions) at a scratch HOME.
async function withScratchHomeRegistry(
  registry: unknown,
  run: (homeDir: string) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-pty-home-"));
  const previousHome = process.env.HOME;
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    await fs.writeFile(path.join(subsDir, "registry.json"), JSON.stringify(registry));
    process.env.HOME = homeDir;
    await run(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function readEnvDump(envDumpPath: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
}

test("claude-pty + claude-home profile: home map env + _meta selector on create AND on owner respawn", async () => {
  await withBridgeNamedMockAgent(async (bridgeScriptPath, scratchDir) => {
    await withScratchHomeRegistry(HYBRID_REGISTRY, async () => {
      const envDumpPath = path.join(scratchDir, "env-dump.json");
      const outbound: OutboundCapture[] = [];
      const client = new AcpClient({
        agentCommand: `node ${JSON.stringify(bridgeScriptPath)} --env-dump-file ${JSON.stringify(envDumpPath)}`,
        cwd: scratchDir,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: "rec-claude-pty", profileId: "home1" },
        onAcpMessage: (direction, message) => {
          if (direction === "outbound") {
            outbound.push(message as OutboundCapture);
          }
        },
      });

      const newSessionEvidence = (): SpawnEvidence["newSessionMeta"] => {
        const request = outbound.findLast((m) => m.method === "session/new");
        return request?.params?._meta;
      };

      try {
        // --- spawn 1: session create ---
        await client.start();
        await client.createSession();
        const firstDump = await readEnvDump(envDumpPath);
        assert.deepEqual(JSON.parse(firstDump.INDEPENDENT_CLAUDE_HOME_MAP ?? "{}"), {
          home1: "/home/node/.acpx/homes/sub1",
          home2: "/home/node/.acpx/homes/sub2",
        });
        assert.equal("CLAUDE_CONFIG_DIR" in firstDump, false);
        assert.equal(newSessionEvidence()?.[INDEPENDENT_CLAUDE_HOME_META_KEY], "home1");

        // --- spawn 2: simulated owner respawn (process restart, record-driven re-resolution) ---
        await fs.rm(envDumpPath);
        outbound.length = 0;
        await client.close();
        await client.start();
        await client.createSession();
        const secondDump = await readEnvDump(envDumpPath);
        assert.deepEqual(JSON.parse(secondDump.INDEPENDENT_CLAUDE_HOME_MAP ?? "{}"), {
          home1: "/home/node/.acpx/homes/sub1",
          home2: "/home/node/.acpx/homes/sub2",
        });
        assert.equal("CLAUDE_CONFIG_DIR" in secondDump, false);
        assert.equal(newSessionEvidence()?.[INDEPENDENT_CLAUDE_HOME_META_KEY], "home1");
      } finally {
        await client.close().catch(() => {});
      }
    });
  });
});

test("claude-pty advertising loadSession:false today — recover-style respawn lands on a fresh session/new", async () => {
  await withBridgeNamedMockAgent(async (bridgeScriptPath, scratchDir) => {
    await withScratchHomeRegistry(HYBRID_REGISTRY, async () => {
      const client = new AcpClient({
        agentCommand: `node ${JSON.stringify(bridgeScriptPath)}`,
        cwd: scratchDir,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: "rec-claude-pty", profileId: "home1" },
      });
      try {
        await client.start();
        // Pilot baseline (PILOT.md §4): the deployed bridge advertises
        // loadSession:false — the capability-driven recover path must then
        // choose a fresh createSession, never a hard-coded per-agent branch.
        assert.equal(client.supportsLoadSession(), false);
        assert.equal(client.supportsResumeSession(), false);
        const created = await client.createSession();
        assert.ok(created.sessionId);
      } finally {
        await client.close().catch(() => {});
      }
    });
  });
});

test("claude-pty advertising loadSession:true later — session/load carries the home selector _meta", async () => {
  await withBridgeNamedMockAgent(async (bridgeScriptPath, scratchDir) => {
    await withScratchHomeRegistry(HYBRID_REGISTRY, async () => {
      const outbound: OutboundCapture[] = [];
      const client = new AcpClient({
        agentCommand: `node ${JSON.stringify(bridgeScriptPath)} --supports-load-session`,
        cwd: scratchDir,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: "rec-claude-pty", profileId: "home2" },
        onAcpMessage: (direction, message) => {
          if (direction === "outbound") {
            outbound.push(message as OutboundCapture);
          }
        },
      });
      try {
        await client.start();
        assert.equal(client.supportsLoadSession(), true);
        const created = await client.createSession();

        // Simulate a bridge-process restart, then the capability-driven load path.
        await client.close();
        await client.start();
        await client.loadSession(created.sessionId);

        const loadRequest = outbound.findLast((m) => m.method === "session/load");
        assert.ok(loadRequest, "expected an outbound session/load request");
        assert.equal(loadRequest.params?._meta?.[INDEPENDENT_CLAUDE_HOME_META_KEY], "home2");
      } finally {
        await client.close().catch(() => {});
      }
    });
  });
});

test("claude-pty + claude-home profile mismatch fails the spawn fast (no wedged session)", async () => {
  await withScratchHomeRegistry(HYBRID_REGISTRY, async (homeDir) => {
    // claude-home profile on a NON-bridge agent command
    const sdkClient = new AcpClient({
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)}`,
      cwd: homeDir,
      permissionMode: "approve-reads",
      sessionContext: { acpxRecordId: "rec-mismatch", profileId: "home1" },
    });
    await assert.rejects(sdkClient.start(), /claude-home.*requires the claude-pty bridge agent/s);
    await sdkClient.close().catch(() => {});
  });

  await withBridgeNamedMockAgent(async (bridgeScriptPath) => {
    await withScratchHomeRegistry(HYBRID_REGISTRY, async (homeDir) => {
      // subscription profile on the bridge agent command
      const bridgeClient = new AcpClient({
        agentCommand: `node ${JSON.stringify(bridgeScriptPath)}`,
        cwd: homeDir,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: "rec-mismatch-2", profileId: "sub1" },
      });
      await assert.rejects(bridgeClient.start(), /cannot be used with the claude-pty bridge agent/);
      await bridgeClient.close().catch(() => {});
    });
  });
});
