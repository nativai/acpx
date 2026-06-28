import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindDefaultAccountToSessionOptions,
  bindRecordToDefaultAccount,
  defaultAccountBindingForAgent,
} from "../src/runtime/engine/default-account-binding.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const CLAUDE_AGENT = "node /opt/claude-agent-acp/dist/index.js";
const CLAUDE_PTY_AGENT = "node /opt/claude-pty-acp/acp-server-transcript.mjs";
const CODEX_AGENT = "npx -y @agentclientprotocol/codex-acp";

type RegistryProfile = Record<string, unknown>;

type RegistrySetup = {
  defaultId?: string;
  profiles: RegistryProfile[];
  existingDirs?: string[];
};

async function withRegistry<T>(
  setup: RegistrySetup,
  run: (ctx: {
    lookupOptions: { homeDir: string; registryPath: string };
    configDir: (id: string) => string;
  }) => Promise<T>,
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-default-binding-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    for (const id of setup.existingDirs ?? []) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
    }
    const registryPath = path.join(subsDir, "registry.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 3,
          ...(setup.defaultId ? { default: setup.defaultId } : {}),
          profiles: setup.profiles,
        },
        null,
        2,
      ),
    );
    return await run({
      lookupOptions: { homeDir, registryPath },
      configDir: (id: string) => path.join(subsDir, id),
    });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function subscriptionProfile(id: string, configDir: string): RegistryProfile {
  return {
    id,
    label: id,
    authMode: "subscription",
    adapter: "claude",
    credentialSource: configDir,
    account: id,
  };
}

test("default profile snapshots onto new session options and preserves model", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      existingDirs: ["sub1"],
      profiles: [],
    },
    async (ctx) => {
      const registryProfile = subscriptionProfile("sub1", ctx.configDir("sub1"));
      await fs.writeFile(
        ctx.lookupOptions.registryPath,
        JSON.stringify({ version: 3, default: "sub1", profiles: [registryProfile] }),
      );
      const result = bindDefaultAccountToSessionOptions(
        { model: "opus" },
        CLAUDE_AGENT,
        ctx.lookupOptions,
      );
      assert.deepEqual(result, { model: "opus", profile: "sub1" });
    },
  );
});

test("first-use binding persists profile and preserves existing non-account options", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      existingDirs: ["sub1"],
      profiles: [],
    },
    async (ctx) => {
      await fs.writeFile(
        ctx.lookupOptions.registryPath,
        JSON.stringify({
          version: 3,
          default: "sub1",
          profiles: [subscriptionProfile("sub1", ctx.configDir("sub1"))],
        }),
      );
      const record = makeSessionRecord({
        acpxRecordId: "rec",
        acpSessionId: "acp",
        agentCommand: CLAUDE_AGENT,
        cwd: "/tmp/project",
        acpx: { session_options: { model: "sonnet", effort: "high" } },
      });

      assert.equal(bindRecordToDefaultAccount(record, ctx.lookupOptions), true);
      assert.equal(record.acpx?.session_options?.profile, "sub1");
      assert.equal(record.acpx?.session_options?.model, "sonnet");
      assert.equal(record.acpx?.session_options?.effort, "high");
    },
  );
});

test("explicit profile or subscription is never overwritten by default binding", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      existingDirs: ["sub1", "sub2"],
      profiles: [],
    },
    async (ctx) => {
      await fs.writeFile(
        ctx.lookupOptions.registryPath,
        JSON.stringify({
          version: 3,
          default: "sub1",
          profiles: [
            subscriptionProfile("sub1", ctx.configDir("sub1")),
            subscriptionProfile("sub2", ctx.configDir("sub2")),
          ],
        }),
      );

      assert.deepEqual(
        bindDefaultAccountToSessionOptions({ profile: "sub2" }, CLAUDE_AGENT, ctx.lookupOptions),
        { profile: "sub2" },
      );
      assert.deepEqual(
        bindDefaultAccountToSessionOptions(
          { subscription: "sub2" },
          CLAUDE_AGENT,
          ctx.lookupOptions,
        ),
        { subscription: "sub2" },
      );
    },
  );
});

test("incompatible default profile is skipped for claude-pty bridge", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      existingDirs: ["sub1"],
      profiles: [],
    },
    async (ctx) => {
      await fs.writeFile(
        ctx.lookupOptions.registryPath,
        JSON.stringify({
          version: 3,
          default: "sub1",
          profiles: [subscriptionProfile("sub1", ctx.configDir("sub1"))],
        }),
      );
      assert.equal(defaultAccountBindingForAgent(CLAUDE_PTY_AGENT, ctx.lookupOptions), undefined);
    },
  );
});

test("adapter-specific defaults bind claude-home for pty and chatgpt for codex", async () => {
  await withRegistry(
    {
      defaultId: "bridge1",
      profiles: [
        {
          id: "bridge1",
          label: "Bridge 1",
          authMode: "claude-home",
          adapter: "claude-pty",
          homePath: "/tmp/bridge1",
          account: "bridge1",
        },
      ],
    },
    async (ctx) => {
      assert.deepEqual(defaultAccountBindingForAgent(CLAUDE_PTY_AGENT, ctx.lookupOptions), {
        profile: "bridge1",
      });
    },
  );

  await withRegistry(
    {
      defaultId: "chatgpt1",
      profiles: [
        {
          id: "chatgpt1",
          label: "ChatGPT 1",
          authMode: "chatgpt",
          adapter: "codex",
          codexHome: "/tmp/codex1",
          account: "chatgpt1",
        },
      ],
    },
    async (ctx) => {
      assert.deepEqual(defaultAccountBindingForAgent(CODEX_AGENT, ctx.lookupOptions), {
        profile: "chatgpt1",
      });
    },
  );
});
