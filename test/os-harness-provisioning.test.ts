import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACPX_EFFECTIVE_PROFILE_ENV,
  applyProfileAuth,
  buildAgentSpawnOptions,
} from "../src/acp/auth-env.js";
import {
  ensureProfileOsHarnessProvisioning,
  type ProvisioningWarningBreadcrumb,
} from "../src/config/os-harness-provisioning.js";
import { findProfile, loadProfileRegistry } from "../src/config/profiles.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";
import { applyLifecycleSnapshotToRecord } from "../src/runtime/engine/lifecycle.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

const SDK_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const CLAUDE_PTY_COMMAND = "node /opt/claude-pty-acp/acp-server-transcript.mjs";
const CODEX_COMMAND = "node /opt/codex-acp/dist/index.js";

type HarnessFixture = {
  root: string;
  homeDir: string;
  registryPath: string;
  sourceDir: string;
  configDir: (id: string) => string;
  lookup: SubscriptionLookupOptions;
};

async function withHarnessFixture(run: (fixture: HarnessFixture) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-w2-harness-"));
  try {
    const homeDir = path.join(root, "home");
    const registryDir = path.join(homeDir, ".acpx", "subscriptions");
    const registryPath = path.join(registryDir, "registry.json");
    const sourceDir = path.join(root, "source-claude");
    await fs.mkdir(registryDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
    await writeSourceHarness(sourceDir);
    await run({
      root,
      homeDir,
      registryPath,
      sourceDir,
      configDir: (id) => path.join(homeDir, ".acpx", "subscriptions", id),
      lookup: { homeDir, registryPath },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSourceHarness(sourceDir: string): Promise<void> {
  await fs.writeFile(
    path.join(sourceDir, "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "echo nativai-os-primer" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.mkdir(path.join(sourceDir, "skills"));
  await fs.mkdir(path.join(sourceDir, "commands"));
  await fs.mkdir(path.join(sourceDir, "plugins"));
  await fs.writeFile(path.join(sourceDir, "skills", "primer.md"), "primer\n");
}

function registryWithProvisioning(
  sourceDir: string,
  profiles: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    version: 3,
    provisioning: {
      osHarness: {
        enabled: true,
        sourceDir,
        entries: ["settings.json", "skills", "commands", "plugins"],
        hook: { event: "SessionStart", marker: "nativai-os-primer" },
      },
    },
    profiles,
  };
}

async function writeRegistry(registryPath: string, registry: unknown): Promise<void> {
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function assertSymlinkTarget(linkPath: string, targetPath: string): Promise<void> {
  const stat = await fs.lstat(linkPath);
  assert.equal(stat.isSymbolicLink(), true, `${linkPath} should be a symlink`);
  const rawTarget = await fs.readlink(linkPath);
  assert.equal(path.resolve(path.dirname(linkPath), rawTarget), path.resolve(targetPath));
}

async function listDirNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).toSorted();
  } catch {
    return [];
  }
}

test("W2 provisioning: subscription anchors symlink entries, rerun is idempotent, and dangling links self-heal", async () => {
  await withHarnessFixture(async (fixture) => {
    const subDir = fixture.configDir("sub1");
    await fs.mkdir(subDir, { recursive: true });
    await writeRegistry(
      fixture.registryPath,
      registryWithProvisioning(fixture.sourceDir, [
        {
          id: "sub1",
          label: "Subscription one",
          authMode: "subscription",
          credentialSource: subDir,
        },
      ]),
    );

    const warnings: ProvisioningWarningBreadcrumb[] = [];
    const env: NodeJS.ProcessEnv = {};
    await applyProfileAuth(
      env,
      "sub1",
      "session-sub",
      null,
      fixture.lookup,
      SDK_CLAUDE_COMMAND,
      (warning) => warnings.push(warning),
    );

    assert.equal(env.CLAUDE_CONFIG_DIR, subDir);
    assert.equal(warnings.length, 0);
    for (const entry of ["settings.json", "skills", "commands", "plugins"]) {
      await assertSymlinkTarget(path.join(subDir, entry), path.join(fixture.sourceDir, entry));
    }

    const firstLinks = await Promise.all(
      ["settings.json", "skills", "commands", "plugins"].map(async (entry) => ({
        entry,
        target: await fs.readlink(path.join(subDir, entry)),
      })),
    );
    await applyProfileAuth(
      env,
      "sub1",
      "session-sub",
      null,
      fixture.lookup,
      SDK_CLAUDE_COMMAND,
      (warning) => warnings.push(warning),
    );
    const secondLinks = await Promise.all(
      ["settings.json", "skills", "commands", "plugins"].map(async (entry) => ({
        entry,
        target: await fs.readlink(path.join(subDir, entry)),
      })),
    );
    assert.deepEqual(secondLinks, firstLinks);

    await fs.unlink(path.join(subDir, "skills"));
    await fs.symlink(path.join(fixture.root, "missing-skills"), path.join(subDir, "skills"));
    await applyProfileAuth(
      env,
      "sub1",
      "session-sub",
      null,
      fixture.lookup,
      SDK_CLAUDE_COMMAND,
      (warning) => warnings.push(warning),
    );
    await assertSymlinkTarget(path.join(subDir, "skills"), path.join(fixture.sourceDir, "skills"));
  });
});

test("W2 provisioning: openrouter temp config dir uses acpx-owned symlinks", async () => {
  await withHarnessFixture(async (fixture) => {
    const tempConfigDir = path.join(fixture.root, "or-session");
    await fs.mkdir(tempConfigDir);
    await writeRegistry(
      fixture.registryPath,
      registryWithProvisioning(fixture.sourceDir, [
        {
          id: "or1",
          label: "OpenRouter",
          authMode: "openrouter",
          model: "anthropic/claude-3-5-sonnet",
          openRouterApiKey: "test-key",
        },
      ]),
    );
    const registry = loadProfileRegistry(fixture.lookup);
    const profile = findProfile("or1", registry);
    assert.ok(profile);

    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env: { CLAUDE_CONFIG_DIR: tempConfigDir },
    });

    for (const entry of ["settings.json", "skills", "commands", "plugins"]) {
      await assertSymlinkTarget(
        path.join(tempConfigDir, entry),
        path.join(fixture.sourceDir, entry),
      );
    }
  });
});

test("W2 provisioning: claude-home merges settings hook and leaves human-owned directories untouched", async () => {
  await withHarnessFixture(async (fixture) => {
    const homePath = path.join(fixture.root, "interactive-home");
    const anchor = path.join(homePath, ".claude");
    await fs.mkdir(path.join(anchor, "commands"), { recursive: true });
    await fs.writeFile(path.join(anchor, "commands", "human.md"), "keep\n");
    await fs.writeFile(
      path.join(anchor, "settings.json"),
      `${JSON.stringify(
        {
          theme: "human",
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo keep" }] }],
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeRegistry(
      fixture.registryPath,
      registryWithProvisioning(fixture.sourceDir, [
        {
          id: "home1",
          label: "Interactive one",
          authMode: "claude-home",
          homePath,
        },
      ]),
    );

    const warnings: ProvisioningWarningBreadcrumb[] = [];
    await withCapturedStderrWrites(async (writes) => {
      await applyProfileAuth(
        {},
        "home1",
        "session-home",
        null,
        fixture.lookup,
        CLAUDE_PTY_COMMAND,
        (warning) => warnings.push(warning),
      );
      assert.match(writes.join(""), /already exists and is not the acpx-owned symlink/);
    });

    const settings = await readJson(path.join(anchor, "settings.json"));
    assert.equal(settings.theme, "human");
    const hooks = settings.hooks as Record<string, unknown>;
    assert.ok(Array.isArray(hooks.PreToolUse));
    const sessionStart = hooks.SessionStart as unknown[];
    assert.equal(sessionStart.length, 1);
    assert.match(JSON.stringify(sessionStart[0]), /nativai-os-primer/);
    await assertSymlinkTarget(path.join(anchor, "skills"), path.join(fixture.sourceDir, "skills"));
    await assertSymlinkTarget(
      path.join(anchor, "plugins"),
      path.join(fixture.sourceDir, "plugins"),
    );
    assert.deepEqual(await listDirNames(path.join(anchor, "commands")), ["human.md"]);
    assert.equal(
      warnings.some((warning) => warning.anchor === anchor),
      true,
    );

    await applyProfileAuth({}, "home1", "session-home", null, fixture.lookup, CLAUDE_PTY_COMMAND);
    const rerunSettings = await readJson(path.join(anchor, "settings.json"));
    const rerunHooks = rerunSettings.hooks as Record<string, unknown>;
    assert.equal((rerunHooks.SessionStart as unknown[]).length, 1);
  });
});

test("W2 provisioning: human-modified marker hook is preserved with a warning", async () => {
  await withHarnessFixture(async (fixture) => {
    const homePath = path.join(fixture.root, "modified-home");
    const anchor = path.join(homePath, ".claude");
    await fs.mkdir(anchor, { recursive: true });
    await fs.writeFile(
      path.join(anchor, "settings.json"),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "echo human nativai-os-primer" }],
            },
          ],
        },
      })}\n`,
    );
    await writeRegistry(
      fixture.registryPath,
      registryWithProvisioning(fixture.sourceDir, [
        { id: "home1", authMode: "claude-home", homePath },
      ]),
    );

    const warnings: ProvisioningWarningBreadcrumb[] = [];
    await applyProfileAuth(
      {},
      "home1",
      "session-home",
      null,
      fixture.lookup,
      CLAUDE_PTY_COMMAND,
      (warning) => warnings.push(warning),
    );
    const settings = await readJson(path.join(anchor, "settings.json"));
    assert.match(JSON.stringify(settings), /echo human nativai-os-primer/);
    assert.equal(
      warnings.some((warning) => warning.message.includes("differs from the source")),
      true,
    );
  });
});

test("W2 provisioning: chatgpt/codex logs and skips without failing spawn", async () => {
  await withHarnessFixture(async (fixture) => {
    const codexHome = path.join(fixture.root, "codex-home");
    await writeRegistry(
      fixture.registryPath,
      registryWithProvisioning(fixture.sourceDir, [
        { id: "codex1", label: "Codex", authMode: "chatgpt", codexHome },
      ]),
    );

    const warnings: ProvisioningWarningBreadcrumb[] = [];
    await withCapturedStderrWrites(async (writes) => {
      await applyProfileAuth(
        {},
        "codex1",
        "session-codex",
        null,
        fixture.lookup,
        CODEX_COMMAND,
        (warning) => warnings.push(warning),
      );
      assert.match(writes.join(""), /no harness materializer for adapter family codex/);
    });
    assert.equal(warnings.at(-1)?.message, "no harness materializer for adapter family codex");
    assert.deepEqual(await listDirNames(codexHome), []);
  });
});

test("W2 provisioning: no registry provisioning block means legacy subscription spawn has no fs writes", async () => {
  await withHarnessFixture(async (fixture) => {
    const subDir = fixture.configDir("sub1");
    await fs.mkdir(subDir, { recursive: true });
    await writeRegistry(fixture.registryPath, {
      default: "sub1",
      subscriptions: [{ id: "sub1", label: "Sub one", configDir: subDir }],
    });

    const options = buildAgentSpawnOptions(
      fixture.root,
      undefined,
      { acpxRecordId: "record-default-off", subscriptionId: "sub1" },
      fixture.lookup,
      SDK_CLAUDE_COMMAND,
    );

    assert.equal(options.env.CLAUDE_CONFIG_DIR, subDir);
    assert.deepEqual(await listDirNames(subDir), []);
    assert.equal(await fileExists(`${fixture.registryPath}.pre-v3.bak`), false);
  });
});

test("W2 provisioning: provisioning errors produce warning breadcrumb and spawn env still resolves", async () => {
  await withHarnessFixture(async (fixture) => {
    const subDir = fixture.configDir("sub1");
    await fs.mkdir(subDir, { recursive: true });
    await writeRegistry(
      fixture.registryPath,
      registryWithProvisioning(path.join(fixture.root, "missing-source"), [
        {
          id: "sub1",
          label: "Subscription one",
          authMode: "subscription",
          credentialSource: subDir,
        },
      ]),
    );

    const warnings: ProvisioningWarningBreadcrumb[] = [];
    const options = buildAgentSpawnOptions(
      fixture.root,
      undefined,
      { acpxRecordId: "record-warning", subscriptionId: "sub1" },
      fixture.lookup,
      SDK_CLAUDE_COMMAND,
      (warning) => warnings.push(warning),
    );

    assert.equal(options.env.CLAUDE_CONFIG_DIR, subDir);
    assert.equal(options.env[ACPX_EFFECTIVE_PROFILE_ENV], "sub1");
    assert.equal(warnings.length > 0, true);
    assert.match(warnings[0]?.message ?? "", /osHarness source entry missing/);

    const record = makeSessionRecord({
      acpxRecordId: "record-warning",
      acpSessionId: "record-warning",
      agentCommand: SDK_CLAUDE_COMMAND,
      cwd: fixture.root,
    });
    applyLifecycleSnapshotToRecord(record, {
      running: true,
      provisioningWarning: warnings[0],
    });
    assert.equal(record.acpx?.session_options?.provisioning_warning?.message, warnings[0]?.message);
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
