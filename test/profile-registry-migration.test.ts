import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACPX_EFFECTIVE_ACCOUNT_ENV,
  ACPX_EFFECTIVE_ADAPTER_ENV,
  ACPX_EFFECTIVE_PROFILE_ENV,
  applyProfileAuth,
} from "../src/acp/auth-env.js";
import {
  loadProfileRegistry,
  resolvePhysicalAccount,
  siblingProfiles,
  transcriptAnchorDir,
  verifyEffectiveResolution,
} from "../src/config/profiles.js";
import { loadSubscriptionRegistry } from "../src/config/subscriptions.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

const SDK_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

type RegistryContext = {
  homeDir: string;
  registryPath: string;
  subsDir: string;
  configDir: (id: string) => string;
};

async function withRegistryFile(
  registry: unknown,
  run: (ctx: RegistryContext) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-w5-registry-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    const registryPath = path.join(subsDir, "registry.json");
    await fs.mkdir(subsDir, { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await run({
      homeDir,
      registryPath,
      subsDir,
      configDir: (id) => path.join(subsDir, id),
    });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function readRegistryJson(registryPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, unknown>;
}

async function fileMode(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("W5 migration: v1-only registry writes v3 profiles, backup, and 0600 perms", async () => {
  await withRegistryFile(
    {
      default: "sub2",
      subscriptions: [
        { id: "sub1", label: "One" },
        { id: "sub2", label: "Two" },
      ],
    },
    async (ctx) => {
      const registry = loadProfileRegistry({
        homeDir: ctx.homeDir,
        registryPath: ctx.registryPath,
      });
      assert.equal(registry.version, 3);
      assert.equal(registry.default, "sub2");
      assert.deepEqual(
        registry.profiles.map((profile) => ({
          id: profile.id,
          authMode: profile.authMode,
          adapter: profile.adapter,
          account: profile.account,
        })),
        [
          { id: "sub1", authMode: "subscription", adapter: "claude", account: "sub1" },
          { id: "sub2", authMode: "subscription", adapter: "claude", account: "sub2" },
        ],
      );

      const migrated = await readRegistryJson(ctx.registryPath);
      assert.equal(migrated.version, 3);
      assert.equal("subscriptions" in migrated, false);
      assert.equal(await fileMode(ctx.registryPath), 0o600);
      assert.equal(await fileMode(`${ctx.registryPath}.pre-v3.bak`), 0o600);

      const subscriptionRegistry = loadSubscriptionRegistry({
        homeDir: ctx.homeDir,
        registryPath: ctx.registryPath,
      });
      assert.deepEqual(
        subscriptionRegistry.subscriptions.map((entry) => ({
          id: entry.id,
          account: entry.account,
        })),
        [
          { id: "sub1", account: "sub1" },
          { id: "sub2", account: "sub2" },
        ],
      );
    },
  );
});

test("W5 migration: hybrid registry unions v1 subscriptions and quarantines claude-deepseek", async () => {
  await withRegistryFile(
    {
      default: "sub1",
      profiles: [
        { id: "sub1", label: "One", harness: "claude", authMode: "subscription" },
        {
          id: "openrouter-test",
          label: "OR",
          harness: "claude",
          authMode: "openrouter",
          model: "anthropic/claude-3-5-sonnet",
          openRouterApiKey: "test-key-never-logged",
          reasoningSupported: true,
          reasoningEffort: "minimal",
        },
        {
          id: "claude-deepseek",
          label: "claude-deepseek template",
          harness: "claude",
          authMode: "chatgpt",
          model: "claude-deepseek-v1",
        },
      ],
      subscriptions: [
        { id: "sub1", label: "One" },
        { id: "sub2", label: "Two" },
      ],
    },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const registry = loadProfileRegistry({
          homeDir: ctx.homeDir,
          registryPath: ctx.registryPath,
        });
        assert.deepEqual(
          registry.profiles.map((profile) => profile.id),
          ["sub1", "openrouter-test", "sub2"],
        );
        assert.equal(registry.quarantined?.length, 1);
        assert.match(registry.quarantined?.[0]?.reason ?? "", /legacy harness conflicts/);
        assert.match(writes.join(""), /registry v3 migration quarantined entry/);
      });

      const migrated = await readRegistryJson(ctx.registryPath);
      assert.equal("subscriptions" in migrated, false);
      assert.equal(
        JSON.stringify(migrated).includes("claude-deepseek") &&
          JSON.stringify(migrated.profiles).includes("claude-deepseek"),
        false,
      );
      assert.ok(Array.isArray(migrated.quarantined));
    },
  );
});

test("W5 migration: profiles-only registry backfills adapter/account and preserves provisioning slot", async () => {
  await withRegistryFile(
    {
      provisioning: { osHarness: { enabled: true, sourceDir: "/home/node/.claude" } },
      profiles: [
        {
          id: "home1",
          label: "Interactive one",
          harness: "claude",
          authMode: "claude-home",
          homePath: "/workspace/projects/temp/w5-selftest/home1",
          accountEmail: "one@example.com",
        },
        { id: "codex-main", label: "Codex", authMode: "chatgpt" },
      ],
    },
    async (ctx) => {
      const registry = loadProfileRegistry({
        homeDir: ctx.homeDir,
        registryPath: ctx.registryPath,
      });
      const home1 = registry.profiles.find((profile) => profile.id === "home1");
      const codex = registry.profiles.find((profile) => profile.id === "codex-main");
      assert.equal(home1?.adapter, "claude-pty");
      assert.equal(home1?.account, "home1");
      assert.equal(codex?.adapter, "codex");
      assert.equal(codex?.account, "codex-main");
      assert.equal(
        codex?.authMode === "chatgpt" ? codex.codexHome : undefined,
        path.join(ctx.homeDir, ".codex"),
      );

      const migrated = await readRegistryJson(ctx.registryPath);
      assert.deepEqual(migrated.provisioning, {
        osHarness: { enabled: true, sourceDir: "/home/node/.claude" },
      });
      assert.equal(JSON.stringify(migrated).includes("harness"), false);
    },
  );
});

test("W5 migration is idempotent on re-run and does not overwrite the pre-v3 backup", async () => {
  await withRegistryFile({ subscriptions: [{ id: "sub1", label: "One" }] }, async (ctx) => {
    loadProfileRegistry({ homeDir: ctx.homeDir, registryPath: ctx.registryPath });
    const firstMigrated = await fs.readFile(ctx.registryPath, "utf8");
    const firstBackup = await fs.readFile(`${ctx.registryPath}.pre-v3.bak`, "utf8");

    loadProfileRegistry({ homeDir: ctx.homeDir, registryPath: ctx.registryPath });
    const secondMigrated = await fs.readFile(ctx.registryPath, "utf8");
    const secondBackup = await fs.readFile(`${ctx.registryPath}.pre-v3.bak`, "utf8");

    assert.equal(secondMigrated, firstMigrated);
    assert.equal(secondBackup, firstBackup);
  });
});

test("W5 invariant stamps selected subscription account and rejects physical-account mismatch", async () => {
  await withRegistryFile(
    {
      profiles: [
        {
          id: "sub1",
          label: "One",
          authMode: "subscription",
          account: "max-1",
          credentialSource: "__SUB1__",
        },
        {
          id: "sub2",
          label: "Two",
          authMode: "subscription",
          account: "max-2",
          credentialSource: "__SUB2__",
        },
      ],
    },
    async (ctx) => {
      const sub1Dir = ctx.configDir("sub1");
      const sub2Dir = ctx.configDir("sub2");
      await fs.mkdir(sub1Dir, { recursive: true });
      await fs.mkdir(sub2Dir, { recursive: true });
      const raw = await fs.readFile(ctx.registryPath, "utf8");
      await fs.writeFile(
        ctx.registryPath,
        raw.replace("__SUB1__", sub1Dir).replace("__SUB2__", sub2Dir),
        { mode: 0o600 },
      );

      const env: NodeJS.ProcessEnv = {};
      await applyProfileAuth(env, "sub2", "session-1", null, ctx, SDK_CLAUDE_COMMAND);
      assert.equal(env.CLAUDE_CONFIG_DIR, sub2Dir);
      assert.equal(env.ACPX_SUBSCRIPTION, "sub2");
      assert.equal(env[ACPX_EFFECTIVE_PROFILE_ENV], "sub2");
      assert.equal(env[ACPX_EFFECTIVE_ACCOUNT_ENV], "max-2");
      assert.equal(env[ACPX_EFFECTIVE_ADAPTER_ENV], "claude");

      const migrated = await readRegistryJson(ctx.registryPath);
      const profiles = migrated.profiles as Array<Record<string, unknown>>;
      const sub2 = profiles.find((profile) => profile.id === "sub2");
      assert.ok(sub2);
      sub2.credentialSource = sub1Dir;
      await fs.writeFile(ctx.registryPath, `${JSON.stringify(migrated, null, 2)}\n`, {
        mode: 0o600,
      });

      await assert.rejects(
        applyProfileAuth({}, "sub2", "session-2", null, ctx, SDK_CLAUDE_COMMAND),
        /recorded account "max-2".*physically resolved account "max-1"/s,
      );
    },
  );
});

test("W5 seam contract: siblings, transcript anchors, and physical account verification", async () => {
  await withRegistryFile(
    {
      profiles: [
        {
          id: "sub1",
          label: "Sub One",
          authMode: "subscription",
          account: "acct-a",
          credentialSource: "__SUB1__",
        },
        {
          id: "sub2",
          label: "Sub Two",
          authMode: "subscription",
          account: "acct-b",
          credentialSource: "__SUB2__",
        },
        {
          id: "sub3-same-account",
          label: "Sub Three",
          authMode: "subscription",
          account: "acct-a",
          credentialSource: "__SUB3__",
        },
        {
          id: "home1",
          label: "Home One",
          authMode: "claude-home",
          account: "home-a",
          homePath: "__HOME1__",
        },
        {
          id: "home2",
          label: "Home Two",
          authMode: "claude-home",
          account: "home-b",
          homePath: "__HOME2__",
        },
        {
          id: "openrouter1",
          label: "OpenRouter One",
          authMode: "openrouter",
          account: "or-a",
          model: "anthropic/claude-3-5-sonnet",
          openRouterApiKey: "test-key",
        },
        {
          id: "codex1",
          label: "Codex One",
          authMode: "chatgpt",
          account: "codex-a",
          codexHome: "__CODEX1__",
        },
      ],
    },
    async (ctx) => {
      const sub1Dir = ctx.configDir("sub1");
      const sub2Dir = ctx.configDir("sub2");
      const sub3Dir = ctx.configDir("sub3");
      const home1 = path.join(ctx.homeDir, "homes", "home1");
      const home2 = path.join(ctx.homeDir, "homes", "home2");
      const codex1 = path.join(ctx.homeDir, "codex", "one");
      const codexOther = path.join(ctx.homeDir, "codex", "other");
      await Promise.all([
        fs.mkdir(sub1Dir, { recursive: true }),
        fs.mkdir(sub2Dir, { recursive: true }),
        fs.mkdir(sub3Dir, { recursive: true }),
        fs.mkdir(path.join(home1, ".claude"), { recursive: true }),
        fs.mkdir(path.join(home2, ".claude"), { recursive: true }),
        fs.mkdir(codex1, { recursive: true }),
        fs.mkdir(codexOther, { recursive: true }),
      ]);

      const raw = await fs.readFile(ctx.registryPath, "utf8");
      await fs.writeFile(
        ctx.registryPath,
        raw
          .replace("__SUB1__", sub1Dir)
          .replace("__SUB2__", sub2Dir)
          .replace("__SUB3__", sub3Dir)
          .replace("__HOME1__", home1)
          .replace("__HOME2__", home2)
          .replace("__CODEX1__", codex1),
        { mode: 0o600 },
      );

      const lookup = { homeDir: ctx.homeDir, registryPath: ctx.registryPath };
      const registry = loadProfileRegistry(lookup);
      assert.deepEqual(
        registry.profiles.map((profile) => [profile.id, profile.adapter]),
        [
          ["sub1", "claude"],
          ["sub2", "claude"],
          ["sub3-same-account", "claude"],
          ["home1", "claude-pty"],
          ["home2", "claude-pty"],
          ["openrouter1", "claude"],
          ["codex1", "codex"],
        ],
      );

      assert.deepEqual(
        (await siblingProfiles("sub1", lookup)).map((profile) => profile.id),
        ["sub2"],
      );
      assert.deepEqual(
        (await siblingProfiles("home1", lookup)).map((profile) => profile.id),
        ["home2"],
      );

      const homeProfile = registry.profiles.find((profile) => profile.id === "home1");
      assert.ok(homeProfile);
      assert.equal(transcriptAnchorDir(homeProfile), path.join(home1, ".claude"));
      assert.equal(await resolvePhysicalAccount(sub2Dir, lookup), "acct-b");
      assert.equal(await resolvePhysicalAccount(path.join(home1, ".claude"), lookup), "home-a");

      const verified = await verifyEffectiveResolution(
        { acpx: { session_options: { profile: "sub2" } } },
        { CLAUDE_CONFIG_DIR: sub2Dir },
        lookup,
      );
      assert.equal(verified.effectiveAccount, "acct-b");
      assert.equal(verified.method, "path");
      assert.equal(verified.verified, true);

      const mismatch = await verifyEffectiveResolution(
        { acpx: { session_options: { profile: "sub2" } } },
        { CLAUDE_CONFIG_DIR: sub1Dir },
        lookup,
      );
      assert.equal(mismatch.effectiveAccount, "acct-a");
      assert.equal(mismatch.method, "path");
      assert.equal(mismatch.verified, false);

      const openrouter = await verifyEffectiveResolution(
        { acpx: { session_options: { profile: "openrouter1" } } },
        { CLAUDE_CONFIG_DIR: path.join(ctx.homeDir, "tmp", "or-session") },
        lookup,
      );
      assert.equal(openrouter.effectiveAccount, "or-a");
      assert.equal(openrouter.method, "selection");
      assert.equal(openrouter.verified, true);

      const chatgpt = await verifyEffectiveResolution(
        { acpx: { session_options: { profile: "codex1" } } },
        { CODEX_HOME: codex1 },
        lookup,
      );
      assert.equal(chatgpt.effectiveAccount, "codex-a");
      assert.equal(chatgpt.method, "path");
      assert.equal(chatgpt.verified, true);

      const chatgptMismatch = await verifyEffectiveResolution(
        { acpx: { session_options: { profile: "codex1" } } },
        { CODEX_HOME: codexOther },
        lookup,
      );
      assert.equal(chatgptMismatch.effectiveAccount, null);
      assert.equal(chatgptMismatch.method, "path");
      assert.equal(chatgptMismatch.verified, false);
    },
  );
});
