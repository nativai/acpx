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
import type { ProvisioningWarningBreadcrumb } from "../src/config/os-harness-provisioning.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";
import { applyLifecycleSnapshotToRecord } from "../src/runtime/engine/lifecycle.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

const SDK_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
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
